/**
 * R-04: After-Hours Backlog Detection
 *
 * Detects inbound customer threads received during configured after-hours coverage
 * windows that remain unanswered 60 minutes after the next regular business-day
 * opening.
 *
 * After-hours windows (Daniel confirmed 2026-10-14):
 *   Monday–Friday: 4:30 PM – 10:00 PM Pacific
 *   Saturday–Sunday: 7:00 AM – 10:00 PM Pacific
 *
 * Deadline: nextBusinessMoment(inboundAt, regularCalendar) + graceMinutes (60 min)
 *   → messages arriving Friday evening must be addressed by Monday 9:00 AM Pacific.
 *
 * Alert lifecycle:
 *   OPEN     — deadline passed, thread still unanswered.
 *   RESOLVED — thread has been replied to after the trigger.
 *
 * Idempotency: unique key (mailbox_address, thread_id, inbound_message_id).
 * Repeated evaluation updates updated_at but never duplicates a record.
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import { isInAfterHoursWindow, nextBusinessMoment } from './business-calendar';
import type { BusinessCalendarConfig, AfterHoursWindow } from './business-calendar';
import { classifyDirection, findOldestUnanswered } from './responsiveness-rule-r01';

export type { AfterHoursWindow } from './business-calendar';

export interface R04Config {
  /** Regular business-hours calendar used to compute the next business opening. */
  readonly businessCalendar: BusinessCalendarConfig;
  /** After-hours coverage windows that make a message eligible for R-04 tracking. */
  readonly afterHoursWindows: ReadonlyArray<AfterHoursWindow>;
  /**
   * Minutes of grace after the next business opening before an OPEN alert fires.
   * Daniel confirmed: 60 minutes (i.e., team must reply by 9:00 AM if open at 8:00 AM).
   */
  readonly graceMinutes: number;
  readonly workspaceDomain: string;
  readonly lookbackDays: number;
}

export type AfterHoursAlertStatus = 'OPEN' | 'RESOLVED';

export interface AfterHoursAlertRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  inboundMessageId: string;
  inboundAt: Date;
  deadlineAt: Date;
  status: AfterHoursAlertStatus;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  gmailThreadUrl: string | null;
}

export interface AfterHoursAlertListFilters {
  mailboxAddress?: string;
  status?: AfterHoursAlertStatus;
  page: number;
  pageSize: number;
}

export interface AfterHoursAlertListResult {
  page: number;
  pageSize: number;
  totalCount: number;
  data: AfterHoursAlertRow[];
}

export interface R04EvalResult {
  threadsEvaluated: number;
  alertsOpened: number;
  alertsClosed: number;
}

export interface R04Rule {
  evaluateMailbox(mailboxAddress: string, config: R04Config, now?: Date): Promise<R04EvalResult>;
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

// ---------------------------------------------------------------------------
// Database mapper
// ---------------------------------------------------------------------------

const toAlertRow = (row: Record<string, unknown>): AfterHoursAlertRow => {
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
    inboundAt: new Date(row['inbound_at'] as string),
    deadlineAt: new Date(row['deadline_at'] as string),
    status: (row['status'] as AfterHoursAlertStatus) ?? 'OPEN',
    resolvedAt: row['resolved_at'] ? new Date(row['resolved_at'] as string) : null,
    createdAt: new Date(row['created_at'] as string),
    updatedAt: new Date(row['updated_at'] as string),
    gmailThreadUrl,
  };
};

// ---------------------------------------------------------------------------
// Dashboard query
// ---------------------------------------------------------------------------

export const listAfterHoursAlerts = async (
  database: Knex,
  filters: AfterHoursAlertListFilters,
): Promise<AfterHoursAlertListResult> => {
  const { page, pageSize } = filters;
  const offset = (page - 1) * pageSize;

  const buildQuery = (db: Knex) => {
    let q = db('google_after_hours_backlog_alerts').where((_b) => true);
    if (filters.mailboxAddress !== undefined) {
      q = q.where('mailbox_address', filters.mailboxAddress);
    }
    if (filters.status !== undefined) {
      q = q.where('status', filters.status);
    }
    return q;
  };

  const countResult = await buildQuery(database)
    .count<{ count: string }>({ count: '*' })
    .first();
  const totalCount = Number(countResult?.count ?? 0);

  const rows = await buildQuery(database)
    .select(
      'id', 'mailbox_address', 'thread_id', 'inbound_message_id',
      'inbound_at', 'deadline_at', 'status', 'resolved_at', 'created_at', 'updated_at',
    )
    .orderBy('inbound_at', 'desc')
    .limit(pageSize)
    .offset(offset) as Record<string, unknown>[];

  return { page, pageSize, totalCount, data: rows.map(toAlertRow) };
};

// ---------------------------------------------------------------------------
// KnexR04Rule
// ---------------------------------------------------------------------------

export class KnexR04Rule implements R04Rule {
  public constructor(private readonly database: Knex = db) {}

  public async evaluateMailbox(
    mailboxAddress: string,
    config: R04Config,
    now: Date = new Date(),
  ): Promise<R04EvalResult> {
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

    let alertsOpened = 0;
    let alertsClosed = 0;

    for (const [threadId, threadRows] of threadMap) {
      const result = await this.evaluateThread(mailboxAddress, threadId, threadRows, config, now);
      alertsOpened += result.alertsOpened;
      alertsClosed += result.alertsClosed;
    }

    return { threadsEvaluated: threadMap.size, alertsOpened, alertsClosed };
  }

  private async evaluateThread(
    mailboxAddress: string,
    threadId: string,
    rows: RawGmailRow[],
    config: R04Config,
    now: Date,
  ): Promise<{ alertsOpened: number; alertsClosed: number }> {
    const messages: ClassifiedMessage[] = [];
    for (const row of rows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(row.payload, config.workspaceDomain);
      if (direction === 'INBOUND' || direction === 'OUTBOUND') {
        messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
      }
    }
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    const oldest = findOldestUnanswered(messages);

    if (oldest === null) {
      // Thread is fully replied — resolve any OPEN alert for it.
      const affected = await this.database('google_after_hours_backlog_alerts')
        .where({ mailbox_address: mailboxAddress, thread_id: threadId, status: 'OPEN' })
        .update({ status: 'RESOLVED', resolved_at: now, updated_at: now });
      return { alertsOpened: 0, alertsClosed: affected };
    }

    // The oldest unanswered must have arrived during a configured after-hours window.
    if (!isInAfterHoursWindow(oldest.internalDate, config.afterHoursWindows, config.businessCalendar.timezone)) {
      return { alertsOpened: 0, alertsClosed: 0 };
    }

    // Compute deadline: next business opening + graceMinutes.
    const nextOpen = nextBusinessMoment(oldest.internalDate, config.businessCalendar);
    const deadline = new Date(nextOpen.getTime() + config.graceMinutes * 60_000);

    if (now < deadline) {
      // Still within grace window — too early to alert.
      return { alertsOpened: 0, alertsClosed: 0 };
    }

    // Deadline has passed and thread is still unanswered → OPEN alert.
    const inserted = await this.openAlert(
      mailboxAddress, threadId, oldest.providerId, oldest.internalDate, deadline, now,
    );
    return { alertsOpened: inserted ? 1 : 0, alertsClosed: 0 };
  }

  /** Atomic insert detection; conflict updates never count as newly opened alerts. */
  private async openAlert(
    mailboxAddress: string,
    threadId: string,
    inboundMessageId: string,
    inboundAt: Date,
    deadline: Date,
    now: Date,
  ): Promise<boolean> {
    const result = await this.database('google_after_hours_backlog_alerts')
      .insert({
        mailbox_address: mailboxAddress,
        thread_id: threadId,
        inbound_message_id: inboundMessageId,
        inbound_at: inboundAt,
        deadline_at: deadline,
        status: 'OPEN',
        resolved_at: null,
        created_at: now,
        updated_at: now,
      })
      .onConflict(['mailbox_address', 'thread_id', 'inbound_message_id'])
      .ignore()
      .returning('id');

    const inserted = Array.isArray(result) ? result.length > 0 : Number(result) > 0;
    if (inserted) return true;

    // notification_generation increments on RESOLVED→OPEN so the notifier re-fires.
    await this.database('google_after_hours_backlog_alerts')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, inbound_message_id: inboundMessageId })
      .update({
        deadline_at: deadline,
        status: 'OPEN',
        resolved_at: null,
        updated_at: now,
        notification_generation: this.database.raw(
          'CASE WHEN status = \'RESOLVED\' THEN notification_generation + 1 ELSE notification_generation END',
        ),
      });
    return false;
  }
}

export const r04Rule = new KnexR04Rule();
