/**
 * R-02: Stalled Thread Detection
 *
 * Detects Gmail threads that have become stalled via two independent conditions:
 *
 *   Condition A — Inactivity:
 *     No classified (INBOUND or OUTBOUND) message activity for >= thresholdMinutes
 *     of coverage time. Daniel confirmed: 24 coverage hours (Mon–Fri 8 AM–10 PM,
 *     Sat–Sun 7 AM–10 PM, America/Los_Angeles). Uses coverageMinutesElapsed.
 *     Production evaluation is gated by conditionAEnabled (env GOOGLE_R02_CONDITION_A_ENABLED).
 *
 *   Condition B — Excessive Exchanges:
 *     Thread has reached or exceeded messageCountThreshold individual classified messages.
 *     Recommends escalation to a phone call.
 *
 * Both conditions are evaluated independently per (mailbox, thread). Neither requires
 * the other to be true. Each has its own row in google_stalled_thread_alerts.
 *
 * Precedence with R-01 (unresolved):
 *   R-01 (google_unanswered_thread_alerts) and R-02 (google_stalled_thread_alerts)
 *   operate independently. An OPEN R-01 alert may coexist with an R-02 INACTIVITY
 *   alert on the same thread. Automatic cross-table suppression has NOT been
 *   implemented — Daniel has not confirmed the desired precedence behaviour.
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 *
 * Architecture: mirrors KnexR01Rule — same message-loading, grouping, and direction-
 * classification pattern, same injectable Knex instance, same repository shape.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import { coverageMinutesElapsed, type BusinessCalendarConfig, type CoverageCalendarConfig } from './business-calendar';
import { classifyDirection } from './responsiveness-rule-r01';

export { type BusinessCalendarConfig, type CoverageCalendarConfig } from './business-calendar';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Whether inactivity is measured in elapsed clock minutes ('ELAPSED') or
 * coverage-hours minutes ('BUSINESS_HOURS').
 *
 * Daniel confirmed: 'BUSINESS_HOURS' using the extended coverage calendar
 * (Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM, America/Los_Angeles).
 * The env default is now 'BUSINESS_HOURS'; 'ELAPSED' remains available for testing.
 */
export type InactivityPolicy = 'ELAPSED' | 'BUSINESS_HOURS';

export interface R02Config {
  readonly businessCalendar: BusinessCalendarConfig;
  /**
   * Coverage calendar used to calculate Condition A inactivity when
   * inactivityPolicy is 'BUSINESS_HOURS'.
   * Daniel confirmed: Mon–Fri 8 AM–10 PM, Sat–Sun 7 AM–10 PM, America/Los_Angeles.
   */
  readonly coverageCalendar: CoverageCalendarConfig;
  /**
   * Minutes of coverage-time inactivity before creating a Condition A alert.
   * Daniel confirmed: 24 coverage hours = 1440 coverage minutes.
   */
  readonly inactivityThresholdMinutes: number;
  /**
   * How to measure the inactivity duration.
   * Daniel confirmed: 'BUSINESS_HOURS' using the coverage calendar above.
   */
  readonly inactivityPolicy: InactivityPolicy;
  /**
   * Whether to emit live Condition A (inactivity) alerts.
   * Kept false by default in env; enable via GOOGLE_R02_CONDITION_A_ENABLED.
   */
  readonly conditionAEnabled: boolean;
  /**
   * Number of classified messages at which Condition B fires and a phone-call
   * escalation is recommended. Daniel confirmed three individual emails.
   */
  readonly messageCountThreshold: number;
  readonly workspaceDomain: string;
  readonly lookbackDays: number;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StallReason = 'INACTIVITY' | 'EXCESSIVE_EXCHANGES';
export type StalledAlertStatus = 'OPEN' | 'RESOLVED';

export interface StalledThreadAlertRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  stallReason: StallReason;
  lastInteractionAt: Date;
  inactivityMinutes: number | null;
  messageCount: number;
  phoneCallRecommended: boolean;
  inactivityThresholdMinutes: number | null;
  messageCountThreshold: number;
  thresholdExceededAt: Date;
  status: StalledAlertStatus;
  resolvedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

// Returned by evaluateMailbox for observability / testing.
export interface R02EvalResult {
  threadsEvaluated: number;
  conditionAFired: number;
  conditionAClosed: number;
  conditionBFired: number;
  conditionBClosed: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
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

/**
 * Compute inactivity in minutes using the configured policy.
 * ELAPSED: wall-clock minutes since last interaction.
 * BUSINESS_HOURS: coverage minutes since last interaction (uses coverageCalendar).
 */
const computeInactivityMinutes = (
  lastInteractionAt: Date,
  now: Date,
  policy: InactivityPolicy,
  coverageCalendar: CoverageCalendarConfig,
): number => {
  if (now <= lastInteractionAt) return 0;
  if (policy === 'BUSINESS_HOURS') {
    return coverageMinutesElapsed(lastInteractionAt, now, coverageCalendar);
  }
  return Math.floor((now.getTime() - lastInteractionAt.getTime()) / 60_000);
};

// ---------------------------------------------------------------------------
// Rule implementation
// ---------------------------------------------------------------------------

export interface R02Rule {
  evaluateMailbox(mailboxAddress: string, config: R02Config, now?: Date): Promise<R02EvalResult>;
}

export class KnexR02Rule implements R02Rule {
  public constructor(private readonly database: Knex = db) {}

  public async evaluateMailbox(
    mailboxAddress: string,
    config: R02Config,
    now: Date = new Date(),
  ): Promise<R02EvalResult> {
    const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);

    // 1. Load recent messages for this mailbox within the lookback window.
    const recentRows = await this.database('raw_gmail_messages')
      .select('provider_message_id', 'thread_id', 'internal_date', 'mailbox_address', 'payload')
      .where({ mailbox_address: mailboxAddress, is_latest: true, is_deleted: false })
      .where('internal_date', '>=', lookbackCutoff)
      .orderBy('internal_date', 'asc') as RawGmailRow[];

    // 2. Load messages for threads that have OPEN R-02 alerts (may predate lookback window).
    const openAlertThreadIds = await this.database('google_stalled_thread_alerts')
      .select('thread_id')
      .where({ mailbox_address: mailboxAddress, status: 'OPEN' })
      .then((rows: { thread_id: string }[]) => [...new Set(rows.map((r) => r.thread_id))]);

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
    const result: R02EvalResult = {
      threadsEvaluated: 0,
      conditionAFired: 0, conditionAClosed: 0,
      conditionBFired: 0, conditionBClosed: 0,
    };
    for (const [threadId, rows] of threadMap) {
      result.threadsEvaluated++;
      const delta = await this.evaluateThread(mailboxAddress, threadId, rows, config, now);
      result.conditionAFired += delta.conditionAFired;
      result.conditionAClosed += delta.conditionAClosed;
      result.conditionBFired += delta.conditionBFired;
      result.conditionBClosed += delta.conditionBClosed;
    }
    return result;
  }

  private async evaluateThread(
    mailboxAddress: string,
    threadId: string,
    rows: RawGmailRow[],
    config: R02Config,
    now: Date,
  ): Promise<Omit<R02EvalResult, 'threadsEvaluated'>> {
    const delta = { conditionAFired: 0, conditionAClosed: 0, conditionBFired: 0, conditionBClosed: 0 };

    // Classify and sort messages; skip unknown-direction and null-date rows.
    const messages: ClassifiedMessage[] = [];
    for (const row of rows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(row.payload, config.workspaceDomain);
      if (direction === 'UNKNOWN') continue;
      messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
    }
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    if (messages.length === 0) {
      // No classifiable messages — close any open stalled alerts for this thread.
      await this.resolveAlert(mailboxAddress, threadId, 'INACTIVITY', now);
      await this.resolveAlert(mailboxAddress, threadId, 'EXCESSIVE_EXCHANGES', now);
      return delta;
    }

    const lastMessage = messages[messages.length - 1]!;
    const lastInteractionAt = lastMessage.internalDate;
    const messageCount = messages.length;
    const phoneCallRecommended = messageCount >= config.messageCountThreshold;

    // --- Condition A: Inactivity ---
    if (config.conditionAEnabled) {
      const inactivityMinutes = computeInactivityMinutes(
        lastInteractionAt, now, config.inactivityPolicy, config.coverageCalendar,
      );
      if (inactivityMinutes >= config.inactivityThresholdMinutes) {
        const fired = await this.upsertAlert(mailboxAddress, threadId, 'INACTIVITY', {
          lastInteractionAt,
          inactivityMinutes,
          messageCount,
          phoneCallRecommended,
          inactivityThresholdMinutes: config.inactivityThresholdMinutes,
          messageCountThreshold: config.messageCountThreshold,
          now,
        });
        if (fired) delta.conditionAFired++;
      } else {
        const closed = await this.resolveAlert(mailboxAddress, threadId, 'INACTIVITY', now);
        if (closed) delta.conditionAClosed++;
      }
    }

    // --- Condition B: Excessive Exchanges ---
    if (phoneCallRecommended) {
      const fired = await this.upsertAlert(mailboxAddress, threadId, 'EXCESSIVE_EXCHANGES', {
        lastInteractionAt,
        inactivityMinutes: null,
        messageCount,
        phoneCallRecommended: true,
        inactivityThresholdMinutes: null,
        messageCountThreshold: config.messageCountThreshold,
        now,
      });
      if (fired) delta.conditionBFired++;
    } else {
      const closed = await this.resolveAlert(mailboxAddress, threadId, 'EXCESSIVE_EXCHANGES', now);
      if (closed) delta.conditionBClosed++;
    }

    return delta;
  }

  /**
   * Inserts an OPEN alert when this is the first evaluation that meets a
   * condition, then refreshes an existing row when the unique key conflicts.
   *
   * The insert uses ON CONFLICT DO NOTHING and RETURNING, so insert-versus-update
   * detection is decided by PostgreSQL's unique-index operation itself. This is
   * deterministic under timestamp precision limits and concurrent evaluators;
   * it does not depend on comparing created_at and updated_at.
   */
  private async upsertAlert(
    mailboxAddress: string,
    threadId: string,
    stallReason: StallReason,
    fields: {
      lastInteractionAt: Date;
      inactivityMinutes: number | null;
      messageCount: number;
      phoneCallRecommended: boolean;
      inactivityThresholdMinutes: number | null;
      messageCountThreshold: number;
      now: Date;
    },
  ): Promise<boolean> {
    const insertResult = await this.database('google_stalled_thread_alerts')
      .insert({
        mailbox_address: mailboxAddress,
        thread_id: threadId,
        stall_reason: stallReason,
        last_interaction_at: fields.lastInteractionAt,
        inactivity_minutes: fields.inactivityMinutes,
        message_count: fields.messageCount,
        phone_call_recommended: fields.phoneCallRecommended,
        inactivity_threshold_minutes: fields.inactivityThresholdMinutes,
        message_count_threshold: fields.messageCountThreshold,
        threshold_exceeded_at: fields.now,
        status: 'OPEN',
        resolved_at: null,
        created_at: fields.now,
        updated_at: fields.now,
      })
      .onConflict(['mailbox_address', 'thread_id', 'stall_reason'])
      .ignore()
      .returning('id');

    const inserted = Array.isArray(insertResult)
      ? insertResult.length > 0
      : Number(insertResult) > 0;

    if (inserted) return true;

    // Conflict path: reopen a resolved alert or refresh an existing OPEN one.
    // threshold_exceeded_at remains the original first-fire timestamp.
    // notification_generation increments on RESOLVED→OPEN so the notifier re-fires.
    await this.database('google_stalled_thread_alerts')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, stall_reason: stallReason })
      .update({
        last_interaction_at: fields.lastInteractionAt,
        inactivity_minutes: fields.inactivityMinutes,
        message_count: fields.messageCount,
        phone_call_recommended: fields.phoneCallRecommended,
        status: 'OPEN',
        resolved_at: null,
        updated_at: fields.now,
        notification_generation: this.database.raw(
          'CASE WHEN status = \'RESOLVED\' THEN notification_generation + 1 ELSE notification_generation END',
        ),
      });
    return false;
  }

  /**
   * Moves an OPEN alert for (mailbox, thread, reason) to RESOLVED.
   * Returns true if at least one row was updated.
   */
  private async resolveAlert(
    mailboxAddress: string,
    threadId: string,
    stallReason: StallReason,
    now: Date,
  ): Promise<boolean> {
    const count = await this.database('google_stalled_thread_alerts')
      .where({ mailbox_address: mailboxAddress, thread_id: threadId, stall_reason: stallReason, status: 'OPEN' })
      .update({ status: 'RESOLVED', resolved_at: now, updated_at: now });
    return (count as number) > 0;
  }
}

// ---------------------------------------------------------------------------
// Dashboard query helper (used by the API route)
// ---------------------------------------------------------------------------

export interface StalledAlertListFilters {
  mailboxAddress?: string;
  status?: StalledAlertStatus;
  stallReason?: StallReason;
  page: number;
  pageSize: number;
}

export interface StalledAlertListRow {
  id: string;
  mailboxAddress: string;
  threadId: string;
  stallReason: StallReason;
  lastInteractionAt: string;
  inactivityMinutes: number | null;
  messageCount: number;
  phoneCallRecommended: boolean;
  status: StalledAlertStatus;
  thresholdExceededAt: string;
  resolvedAt: string | null;
  /** Stable Gmail web link constructed from thread_id. May be null if thread_id is empty. */
  gmailThreadUrl: string | null;
}

export interface StalledAlertListResult {
  page: number;
  pageSize: number;
  totalCount: number;
  data: StalledAlertListRow[];
}

const GMAIL_THREAD_BASE = 'https://mail.google.com/mail/#all/';

const toListRow = (raw: Record<string, unknown>): StalledAlertListRow => ({
  id: String(raw.id),
  mailboxAddress: String(raw.mailbox_address),
  threadId: String(raw.thread_id),
  stallReason: raw.stall_reason as StallReason,
  lastInteractionAt: raw.last_interaction_at instanceof Date
    ? raw.last_interaction_at.toISOString()
    : String(raw.last_interaction_at),
  inactivityMinutes: raw.inactivity_minutes != null ? Number(raw.inactivity_minutes) : null,
  messageCount: Number(raw.message_count),
  phoneCallRecommended: Boolean(raw.phone_call_recommended),
  status: raw.status as StalledAlertStatus,
  thresholdExceededAt: raw.threshold_exceeded_at instanceof Date
    ? raw.threshold_exceeded_at.toISOString()
    : String(raw.threshold_exceeded_at),
  resolvedAt: raw.resolved_at != null
    ? (raw.resolved_at instanceof Date ? raw.resolved_at.toISOString() : String(raw.resolved_at))
    : null,
  gmailThreadUrl: raw.thread_id ? `${GMAIL_THREAD_BASE}${String(raw.thread_id)}` : null,
});

export const listStalledAlerts = async (
  database: Knex,
  filters: StalledAlertListFilters,
): Promise<StalledAlertListResult> => {
  const { mailboxAddress, status, stallReason, page, pageSize } = filters;

  const applyFilters = (q: Knex.QueryBuilder): Knex.QueryBuilder => {
    if (mailboxAddress) q = q.where({ mailbox_address: mailboxAddress });
    if (status) q = q.where({ status });
    if (stallReason) q = q.where({ stall_reason: stallReason });
    return q;
  };

  const countRow = await applyFilters(
    database('google_stalled_thread_alerts').count<{ count: string }>({ count: '*' }),
  ).first() as { count: string } | undefined;

  const totalCount = countRow ? parseInt(countRow.count, 10) : 0;

  const rows = await applyFilters(
    database('google_stalled_thread_alerts')
      .select(
        'id', 'mailbox_address', 'thread_id', 'stall_reason',
        'last_interaction_at', 'inactivity_minutes', 'message_count',
        'phone_call_recommended', 'status', 'threshold_exceeded_at',
        'resolved_at',
      )
      .orderBy('threshold_exceeded_at', 'desc')
      .limit(pageSize)
      .offset((page - 1) * pageSize),
  ) as Record<string, unknown>[];

  return { page, pageSize, totalCount, data: rows.map(toListRow) };
};

export const r02Rule = new KnexR02Rule();
