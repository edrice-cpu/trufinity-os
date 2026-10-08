/**
 * R-01: Unanswered Inbound Email Detection
 *
 * Deterministic rule (no ML classification) that detects inbound customer
 * emails that remain unanswered beyond the configured business-hours threshold.
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 *
 * Architecture:
 * - Reads raw_gmail_messages (is_latest=true, is_deleted=false)
 * - Groups messages by thread_id
 * - Classifies each message as INBOUND / OUTBOUND / INTERNAL using labelIds + From header
 * - Determines the "pending segment": inbound messages since the most recent outbound
 * - If elapsed business minutes >= threshold → upserts google_unanswered_thread_alerts
 * - If thread has been replied to → closes any OPEN alert for that thread
 *
 * Idempotency: unique key (mailbox_address, thread_id, oldest_unanswered_message_id)
 * ensures repeated evaluation never duplicates alerts.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import { businessMinutesElapsed, nextBusinessMoment } from './business-calendar';
import type { BusinessCalendarConfig } from './business-calendar';

export { type BusinessCalendarConfig } from './business-calendar';

export interface R01Config {
  /** Business-hours calendar to use for elapsed-time calculations. */
  readonly businessCalendar: BusinessCalendarConfig;
  /**
   * Elapsed business minutes before creating an alert.
   * Product-confirmed default: requires operator confirmation before production use.
   * See GOOGLE_R01_THRESHOLD_MINUTES in env.ts.
   */
  readonly thresholdMinutes: number;
  /**
   * Company workspace domain used to distinguish internal from external senders.
   * Inbound = From-header domain does NOT end with this value.
   * E.g. 'trufinity.ca'
   */
  readonly workspaceDomain: string;
  /**
   * How many days back to scan for thread activity.
   * Threads with no messages in this window are skipped unless they have an
   * OPEN alert (those are always re-evaluated).
   */
  readonly lookbackDays: number;
}

export interface UnansweredThreadAlertRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  oldestUnansweredMessageId: string;
  oldestUnansweredAt: Date;
  thresholdExceededAt: Date;
  businessMinutesElapsed: number;
  thresholdMinutes: number;
  status: 'OPEN' | 'REPLIED';
  repliedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface RawGmailRow {
  provider_message_id: string;
  thread_id: string;
  internal_date: Date | null;
  mailbox_address: string;
  payload: Record<string, unknown> | null;
}

type MessageDirection = 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';

interface ThreadMessage {
  providerId: string;
  internalDate: Date;
  direction: MessageDirection;
}

/** Extract a named header value from a persisted Gmail payload. */
const extractHeader = (payload: Record<string, unknown> | null, name: string): string | null => {
  if (!payload || !Array.isArray(payload.headers)) return null;
  const nameLower = name.toLowerCase();
  for (const h of payload.headers as unknown[]) {
    if (typeof h !== 'object' || h === null) continue;
    const entry = h as Record<string, unknown>;
    if (typeof entry.name === 'string' && entry.name.toLowerCase() === nameLower && typeof entry.value === 'string') {
      return entry.value;
    }
  }
  return null;
};

/** Extract the domain part of an email address (From header value). */
const emailDomain = (raw: string | null): string | null => {
  if (!raw) return null;
  const match = /<([^>]+)>/.exec(raw) ?? null;
  const addr = match ? match[1].trim() : raw.trim();
  const at = addr.indexOf('@');
  return at !== -1 ? addr.slice(at + 1).toLowerCase() : null;
};

/** True when the label array (from payload.labelIds) contains the given label. */
const hasLabel = (payload: Record<string, unknown> | null, label: string): boolean => {
  if (!payload || !Array.isArray(payload.labelIds)) return false;
  return (payload.labelIds as unknown[]).some(
    (l) => typeof l === 'string' && l.toUpperCase() === label.toUpperCase(),
  );
};

/**
 * Classify one message as INBOUND, OUTBOUND, or UNKNOWN.
 *
 * INBOUND:  Has INBOX label AND From-header domain is external (not workspaceDomain).
 * OUTBOUND: Has SENT label.
 * UNKNOWN:  Neither — e.g. internal messages, drafts, system messages. Ignored by R-01.
 *
 * A message can have both INBOX and SENT (e.g. a self-sent note).
 * SENT takes precedence → OUTBOUND, so self-sent messages don't create false pending states.
 */
export const classifyDirection = (
  payload: Record<string, unknown> | null,
  workspaceDomain: string,
): MessageDirection => {
  if (!payload) return 'UNKNOWN';
  if (hasLabel(payload, 'SENT')) return 'OUTBOUND';
  if (!hasLabel(payload, 'INBOX')) return 'UNKNOWN';
  const from = extractHeader(payload, 'From');
  const domain = emailDomain(from);
  if (!domain) return 'UNKNOWN';
  // Internal sender → UNKNOWN (not a customer email).
  // Must be an exact match or a real subdomain (*.workspaceDomain) to prevent
  // spoofing: 'nottrufinity.ca'.endsWith('trufinity.ca') is true but is external.
  const normalised = workspaceDomain.replace(/^\./, '').toLowerCase();
  if (domain === normalised || domain.endsWith('.' + normalised)) return 'UNKNOWN';
  return 'INBOUND';
};

/**
 * Given a chronologically-sorted list of thread messages (INBOUND/OUTBOUND only),
 * return the oldest unanswered inbound message, or null if the thread is fully replied.
 *
 * "Pending segment" = all INBOUND messages that appear AFTER the most recent OUTBOUND.
 * If there is no OUTBOUND at all, all INBOUNDs are pending.
 * If the most recent message is OUTBOUND, the thread is replied → no pending.
 */
export const findOldestUnanswered = (
  messages: ThreadMessage[],
): ThreadMessage | null => {
  // Walk backwards to find the most recent OUTBOUND
  let lastOutboundIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.direction === 'OUTBOUND') {
      lastOutboundIdx = i;
      break;
    }
  }

  // All messages after the last OUTBOUND that are INBOUND = pending
  const pendingStart = lastOutboundIdx + 1;
  for (let i = pendingStart; i < messages.length; i++) {
    if (messages[i]!.direction === 'INBOUND') {
      return messages[i]!;
    }
  }
  return null;
};

export interface R01Rule {
  evaluateMailbox(mailboxAddress: string, config: R01Config, now?: Date): Promise<void>;
}

export class KnexR01Rule implements R01Rule {
  public constructor(private readonly database: Knex = db) {}

  public async evaluateMailbox(
    mailboxAddress: string,
    config: R01Config,
    now: Date = new Date(),
  ): Promise<void> {
    const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);

    // 1. Load all current messages in the lookback window for this mailbox.
    const recentRows = await this.database('raw_gmail_messages')
      .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
      .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
      .where('internal_date', '>=', lookbackCutoff)
      .orderBy('internal_date', 'asc') as RawGmailRow[];

    // 2. Also load messages for threads that have OPEN alerts (outside lookback window).
    const openAlertThreadIds = await this.database('google_unanswered_thread_alerts')
      .select('thread_id')
      .where({ mailbox_address: mailboxAddress, status: 'OPEN' })
      .then((rows: { thread_id: string }[]) => rows.map((r) => r.thread_id));

    let extraRows: RawGmailRow[] = [];
    if (openAlertThreadIds.length > 0) {
      extraRows = await this.database('raw_gmail_messages')
        .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
        .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
        .whereIn('thread_id', openAlertThreadIds)
        .where('internal_date', '<', lookbackCutoff)
        .orderBy('internal_date', 'asc') as RawGmailRow[];
    }

    // 3. Group all rows by thread_id.
    const allRows = [...recentRows, ...extraRows];
    const threadMap = new Map<string, RawGmailRow[]>();
    for (const row of allRows) {
      if (!row.thread_id) continue;
      const existing = threadMap.get(row.thread_id) ?? [];
      existing.push(row);
      threadMap.set(row.thread_id, existing);
    }

    // 4. Evaluate each thread.
    for (const [threadId, rows] of threadMap) {
      await this.evaluateThread(mailboxAddress, threadId, rows, config, now);
    }
  }

  private async evaluateThread(
    mailboxAddress: string,
    threadId: string,
    rows: RawGmailRow[],
    config: R01Config,
    now: Date,
  ): Promise<void> {
    // Build classified, timestamped message list (skip unknown-direction and null-date rows).
    const messages: ThreadMessage[] = [];
    for (const row of rows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(row.payload, config.workspaceDomain);
      if (direction === 'UNKNOWN') continue;
      messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
    }

    // Sort chronologically.
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    const oldest = findOldestUnanswered(messages);

    if (!oldest) {
      // Thread is fully replied — close any OPEN alert.
      await this.closeAlert(mailboxAddress, threadId, now);
      return;
    }

    // Compute elapsed business time from the effective start of the pending segment.
    // If the inbound arrived outside business hours, aging starts at the next opening.
    const agingStart = nextBusinessMoment(oldest.internalDate, config.businessCalendar);
    const elapsedMinutes = businessMinutesElapsed(agingStart, now, config.businessCalendar);

    if (elapsedMinutes < config.thresholdMinutes) {
      // Below threshold — no alert yet, and no state to update.
      return;
    }

    // Threshold exceeded: upsert alert.
    await this.upsertAlert(
      mailboxAddress,
      threadId,
      oldest.providerId,
      oldest.internalDate,
      elapsedMinutes,
      config.thresholdMinutes,
      now,
    );
  }

  private async upsertAlert(
    mailboxAddress: string,
    threadId: string,
    oldestUnansweredMessageId: string,
    oldestUnansweredAt: Date,
    elapsedMinutes: number,
    thresholdMinutes: number,
    now: Date,
  ): Promise<void> {
    await this.database('google_unanswered_thread_alerts')
      .insert({
        mailbox_address: mailboxAddress,
        thread_id: threadId,
        oldest_unanswered_message_id: oldestUnansweredMessageId,
        oldest_unanswered_at: oldestUnansweredAt,
        threshold_exceeded_at: now,
        business_minutes_elapsed: elapsedMinutes,
        threshold_minutes: thresholdMinutes,
        status: 'OPEN',
        replied_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict(['mailbox_address', 'thread_id', 'oldest_unanswered_message_id'])
      // On repeated evaluation: update elapsed time and updated_at only.
      // threshold_exceeded_at is NOT updated — preserves the original detection timestamp.
      .merge({
        business_minutes_elapsed: elapsedMinutes,
        updated_at: now,
      });
  }

  private async closeAlert(
    mailboxAddress: string,
    threadId: string,
    now: Date,
  ): Promise<void> {
    await this.database('google_unanswered_thread_alerts')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, status: 'OPEN' })
      .update({ status: 'REPLIED', replied_at: now, updated_at: now });
  }
}

export const r01Rule = new KnexR01Rule();
