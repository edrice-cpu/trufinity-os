/**
 * R-03: Reply Latency Outlier Detection
 *
 * Measures how long the team takes to reply to each inbound customer message.
 * For every INBOUND→OUTBOUND adjacent pair in a thread, the business-minutes
 * elapsed is calculated and recorded. If elapsed exceeds the mailbox threshold,
 * a LATE record is written to google_reply_latency_records.
 *
 * Mailbox thresholds (Daniel confirmed 2026-10-14):
 *   service@trufinity.ca  → 240 min (4 business hours)
 *   support@trufinity.ca  → 240 min (4 business hours)
 *   other mailboxes       → configured default (default 510 min = ~1 business day)
 *
 * Excluded mailboxes (never processed):
 *   billing@trufinity.ca, careers@trufinity.ca, info@trufinity.ca
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 *
 * Idempotency: unique key (mailbox_address, thread_id, inbound_message_id).
 * Repeated evaluation updates business_minutes_elapsed and status but never
 * duplicates a record.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import { businessMinutesElapsed, nextBusinessMoment } from './business-calendar';
import type { BusinessCalendarConfig } from './business-calendar';
import { classifyDirection } from './responsiveness-rule-r01';

export interface R03Config {
  readonly businessCalendar: BusinessCalendarConfig;
  /**
   * Default latency threshold for mailboxes not listed in mailboxThresholds.
   * Daniel confirmed: 1 business day for personal/other mailboxes.
   * Default env: GOOGLE_R03_DEFAULT_THRESHOLD_MINUTES (510 min ≈ 8h30m business day).
   */
  readonly defaultThresholdMinutes: number;
  /**
   * Per-mailbox threshold overrides.
   * Daniel confirmed: service@ and support@ both = 240 min (4 business hours).
   */
  readonly mailboxThresholds: Record<string, number>;
  /**
   * Mailboxes to exclude entirely from R-03 processing.
   * Daniel confirmed: billing@, careers@, info@trufinity.ca.
   */
  readonly excludedMailboxes: ReadonlyArray<string>;
  readonly workspaceDomain: string;
  readonly lookbackDays: number;
}

export type ReplyLatencyStatus = 'ON_TIME' | 'LATE';

export interface ReplyLatencyRecord {
  id: string;
  mailboxAddress: string;
  threadId: string;
  inboundMessageId: string;
  replyMessageId: string;
  inboundAt: Date;
  repliedAt: Date;
  businessMinutesElapsed: number;
  status: ReplyLatencyStatus;
  thresholdMinutes: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface ReplyLatencyListFilters {
  mailboxAddress?: string;
  status?: ReplyLatencyStatus;
  fromDate?: Date;
  toDate?: Date;
  page: number;
  pageSize: number;
}

export interface ReplyLatencyListRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  inboundMessageId: string;
  replyMessageId: string;
  inboundAt: Date;
  repliedAt: Date;
  businessMinutesElapsed: number;
  status: ReplyLatencyStatus;
  thresholdMinutes: number;
  createdAt: Date;
  gmailThreadUrl: string | null;
}

export interface ReplyLatencyListResult {
  page: number;
  pageSize: number;
  totalCount: number;
  data: ReplyLatencyListRow[];
}

export interface R03EvalResult {
  threadsEvaluated: number;
  repliesMeasured: number;
  lateRepliesFound: number;
  onTimeRepliesFound: number;
}

export interface R03Rule {
  evaluateMailbox(mailboxAddress: string, config: R03Config, now?: Date): Promise<R03EvalResult>;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawGmailRow {
  provider_message_id: string;
  thread_id: string;
  internal_date: Date | null;
  mailbox_address: string;
  payload: Record<string, unknown> | null;
}

interface ClassifiedMessage {
  providerId: string;
  internalDate: Date;
  direction: 'INBOUND' | 'OUTBOUND';
}

interface ReplyPair {
  inbound: ClassifiedMessage;
  reply: ClassifiedMessage;
}

// ---------------------------------------------------------------------------
// Pure helpers — exported for unit tests
// ---------------------------------------------------------------------------

/**
 * Determine the threshold in business minutes for a given mailbox address.
 * Falls back to config.defaultThresholdMinutes when no per-mailbox override exists.
 */
export const resolveThreshold = (mailboxAddress: string, config: R03Config): number => {
  const key = mailboxAddress.toLowerCase().trim();
  return config.mailboxThresholds[key] ?? config.defaultThresholdMinutes;
};

/**
 * Return true when this mailbox is in the exclusion list.
 */
export const isExcludedMailbox = (mailboxAddress: string, config: R03Config): boolean => {
  const key = mailboxAddress.toLowerCase().trim();
  return config.excludedMailboxes.some((ex) => ex.toLowerCase().trim() === key);
};

/**
 * Given a chronologically-sorted list of classified messages (INBOUND/OUTBOUND only),
 * return one INBOUND→OUTBOUND pair per "pending segment".
 *
 * A pending segment is one or more consecutive INBOUND messages with no OUTBOUND
 * in between. Latency is measured from the **earliest** inbound in the segment to
 * the first OUTBOUND that closes it. One record per response event — not one per
 * inbound message — to avoid overcounting when a customer sends multiple follow-ups
 * before the team replies.
 *
 * Multi-participant threads: all INBOUND messages are pooled regardless of sender.
 * The "customer wait" is measured from the first unanswered customer message.
 *
 * Unanswered messages (remaining pendingInbounds at end) are R-01's domain.
 */
export const findReplyPairs = (messages: ClassifiedMessage[]): ReplyPair[] => {
  const pairs: ReplyPair[] = [];
  let earliestPending: ClassifiedMessage | null = null;

  for (const msg of messages) {
    if (msg.direction === 'INBOUND') {
      // Track only the first inbound in the pending segment.
      if (earliestPending === null) {
        earliestPending = msg;
      }
    } else {
      // OUTBOUND: if there is a pending inbound segment, emit one pair from the earliest.
      if (earliestPending !== null) {
        pairs.push({ inbound: earliestPending, reply: msg });
        earliestPending = null;
      }
      // Consecutive OUTBOUND messages (e.g. a follow-up reply) produce no new pair
      // until another INBOUND arrives — consistent with "pending = waiting for team".
    }
  }
  // Any remaining earliestPending is unanswered — R-01 handles those.
  return pairs;
};

// ---------------------------------------------------------------------------
// Database mapper
// ---------------------------------------------------------------------------

const toListRow = (row: Record<string, unknown>): ReplyLatencyListRow => {
  const mailboxAddress = String(row['mailbox_address'] ?? '');
  const threadId = String(row['thread_id'] ?? '');
  const gmailThreadUrl = mailboxAddress && threadId
    ? `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(mailboxAddress)}#all/${threadId}`
    : null;

  return {
    id: String(row['id'] ?? ''),
    mailboxAddress,
    threadId,
    inboundMessageId: String(row['inbound_message_id'] ?? ''),
    replyMessageId: String(row['reply_message_id'] ?? ''),
    inboundAt: new Date(row['inbound_at'] as string),
    repliedAt: new Date(row['replied_at'] as string),
    businessMinutesElapsed: Number(row['business_minutes_elapsed'] ?? 0),
    status: (row['status'] as ReplyLatencyStatus) ?? 'ON_TIME',
    thresholdMinutes: Number(row['threshold_minutes'] ?? 0),
    createdAt: new Date(row['created_at'] as string),
    gmailThreadUrl,
  };
};

// ---------------------------------------------------------------------------
// Dashboard query
// ---------------------------------------------------------------------------

export const listReplyLatencyRecords = async (
  database: Knex,
  filters: ReplyLatencyListFilters,
): Promise<ReplyLatencyListResult> => {
  const { page, pageSize } = filters;
  const offset = (page - 1) * pageSize;

  const buildQuery = (db: Knex) => {
    let q = db('google_reply_latency_records').where((_b) => true);
    if (filters.mailboxAddress !== undefined) {
      q = q.where('mailbox_address', filters.mailboxAddress);
    }
    if (filters.status !== undefined) {
      q = q.where('status', filters.status);
    }
    if (filters.fromDate !== undefined) {
      q = q.where('inbound_at', '>=', filters.fromDate);
    }
    if (filters.toDate !== undefined) {
      q = q.where('inbound_at', '<=', filters.toDate);
    }
    return q;
  };

  const countResult = await buildQuery(database)
    .count<{ count: string }>({ count: '*' })
    .first();
  const totalCount = Number(countResult?.count ?? 0);

  const rows = await buildQuery(database)
    .select(
      'id', 'mailbox_address', 'thread_id', 'inbound_message_id', 'reply_message_id',
      'inbound_at', 'replied_at', 'business_minutes_elapsed', 'status',
      'threshold_minutes', 'created_at',
    )
    .orderBy('inbound_at', 'desc')
    .limit(pageSize)
    .offset(offset) as Record<string, unknown>[];

  return { page, pageSize, totalCount, data: rows.map(toListRow) };
};

// ---------------------------------------------------------------------------
// KnexR03Rule
// ---------------------------------------------------------------------------

export class KnexR03Rule implements R03Rule {
  public constructor(private readonly database: Knex = db) {}

  public async evaluateMailbox(
    mailboxAddress: string,
    config: R03Config,
    now: Date = new Date(),
  ): Promise<R03EvalResult> {
    if (isExcludedMailbox(mailboxAddress, config)) {
      return { threadsEvaluated: 0, repliesMeasured: 0, lateRepliesFound: 0, onTimeRepliesFound: 0 };
    }

    const threshold = resolveThreshold(mailboxAddress, config);
    const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);

    const rows = await this.database('raw_gmail_messages')
      .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
      .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
      .where('internal_date', '>=', lookbackCutoff)
      .orderBy('internal_date', 'asc') as RawGmailRow[];

    // Group by thread
    const threadMap = new Map<string, RawGmailRow[]>();
    for (const row of rows) {
      if (!row.thread_id) continue;
      const existing = threadMap.get(row.thread_id) ?? [];
      existing.push(row);
      threadMap.set(row.thread_id, existing);
    }

    let repliesMeasured = 0;
    let lateRepliesFound = 0;
    let onTimeRepliesFound = 0;

    for (const [threadId, threadRows] of threadMap) {
      const result = await this.evaluateThread(
        mailboxAddress, threadId, threadRows, config, threshold, now,
      );
      repliesMeasured += result.repliesMeasured;
      lateRepliesFound += result.lateRepliesFound;
      onTimeRepliesFound += result.onTimeRepliesFound;
    }

    return {
      threadsEvaluated: threadMap.size,
      repliesMeasured,
      lateRepliesFound,
      onTimeRepliesFound,
    };
  }

  private async evaluateThread(
    mailboxAddress: string,
    threadId: string,
    rows: RawGmailRow[],
    config: R03Config,
    threshold: number,
    now: Date,
  ): Promise<{ repliesMeasured: number; lateRepliesFound: number; onTimeRepliesFound: number }> {
    const messages: ClassifiedMessage[] = [];
    for (const row of rows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(row.payload, config.workspaceDomain);
      if (direction === 'UNKNOWN') continue;
      messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
    }

    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    const pairs = findReplyPairs(messages);
    let repliesMeasured = 0;
    let lateRepliesFound = 0;
    let onTimeRepliesFound = 0;

    for (const pair of pairs) {
      const agingStart = nextBusinessMoment(pair.inbound.internalDate, config.businessCalendar);
      const elapsed = businessMinutesElapsed(agingStart, pair.reply.internalDate, config.businessCalendar);
      const status: ReplyLatencyStatus = elapsed > threshold ? 'LATE' : 'ON_TIME';

      const inserted = await this.upsertRecord(
        mailboxAddress, threadId,
        pair.inbound.providerId, pair.reply.providerId,
        pair.inbound.internalDate, pair.reply.internalDate,
        elapsed, status, threshold, now,
      );

      repliesMeasured++;
      // The worker uses this count to report newly opened alerts.  A repeated
      // evaluation still refreshes the persisted row, but must not report the
      // existing late reply as a new alert.
      if (status === 'LATE') {
        if (inserted) lateRepliesFound++;
      } else {
        onTimeRepliesFound++;
      }
    }

    void now; // `now` available for future use (e.g. skipping future-dated pairs)
    return { repliesMeasured, lateRepliesFound, onTimeRepliesFound };
  }

  private async upsertRecord(
    mailboxAddress: string,
    threadId: string,
    inboundMessageId: string,
    replyMessageId: string,
    inboundAt: Date,
    repliedAt: Date,
    elapsedMinutes: number,
    status: ReplyLatencyStatus,
    thresholdMinutes: number,
    now: Date,
  ): Promise<boolean> {
    const insertResult = await this.database('google_reply_latency_records')
      .insert({
        mailbox_address: mailboxAddress,
        thread_id: threadId,
        inbound_message_id: inboundMessageId,
        reply_message_id: replyMessageId,
        inbound_at: inboundAt,
        replied_at: repliedAt,
        business_minutes_elapsed: elapsedMinutes,
        status,
        threshold_minutes: thresholdMinutes,
        created_at: now,
        updated_at: now,
      })
      .onConflict(['mailbox_address', 'thread_id', 'inbound_message_id'])
      .ignore()
      .returning('id');

    const inserted = Array.isArray(insertResult)
      ? insertResult.length > 0
      : Number(insertResult) > 0;

    if (inserted) return true;

    await this.database('google_reply_latency_records')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, inbound_message_id: inboundMessageId })
      .update({
        reply_message_id: replyMessageId,
        replied_at: repliedAt,
        business_minutes_elapsed: elapsedMinutes,
        status,
        updated_at: now,
      });
    return false;
  }
}

export const r03Rule = new KnexR03Rule();
