/**
 * R-05: Aging Queue Reporting
 *
 * Read-only reporting feature. Returns all currently unanswered inbound threads
 * per mailbox, including those that have not yet exceeded R-01 SLA thresholds.
 *
 * Two endpoints:
 *   GET /api/google/reporting/responsiveness/aging-queue/summary   — per-mailbox totals
 *   GET /api/google/reporting/responsiveness/aging-queue           — paginated thread list
 *
 * Detection logic reuses R-01 helpers (classifyDirection, findOldestUnanswered).
 * No new alerts are created; no database writes occur.
 *
 * Privacy: operates only on persisted METADATA (headers, labelIds, timestamps).
 * Never reads Gmail body, snippet, HTML, or attachment content.
 *
 * Historical coverage limitation:
 *   Only threads with at least one message within the configured lookbackDays
 *   window are included. Threads whose messages all pre-date the lookback cutoff
 *   will not appear even if still unanswered. Callers should document this boundary
 *   when surfacing these metrics to end-users.
 *
 * Performance note:
 *   Results are computed per-mailbox in application memory (same pattern as R-01).
 *   For high-volume mailboxes a materialized view would improve latency; that
 *   optimization is deferred until volume data is available.
 */

import type { Knex } from 'knex';
import { db } from '../../database';
import {
  businessMinutesElapsed,
  createBusinessMinutesCalculator,
  nextBusinessMoment,
} from './business-calendar';
import type { BusinessCalendarConfig } from './business-calendar';
import { classifyDirection, findOldestUnanswered } from './responsiveness-rule-r01';
import { recomputeGmailThreadState, type GmailMessageDirection } from './gmail-thread-state.service';

export interface R05Config {
  readonly businessCalendar: BusinessCalendarConfig;
  readonly workspaceDomain: string;
  /**
   * How many days back to scan for thread activity.
   * Threads with ALL messages outside this window are invisible to R-05 — see
   * the historical coverage limitation note above.
   */
  readonly lookbackDays: number;
  /**
   * Optional R-01 business-hours threshold (minutes). When provided, the summary
   * includes a `threadsOverR01Threshold` count. When undefined, that field is null.
   */
  readonly r01ThresholdMinutes?: number;
  /** Enables the metadata-only Phase 2 read path after a complete backfill. */
  readonly useThreadState?: boolean;
}

export class R05BackfillIncompleteError extends Error {
  public readonly statusCode = 503;
  public readonly code = 'R05_BACKFILL_INCOMPLETE';

  public constructor() {
    super('R-05 aging queue is temporarily unavailable while thread state backfill completes.');
    this.name = 'R05BackfillIncompleteError';
  }
}

export interface AgingQueueEntry {
  mailboxAddress: string;
  threadId: string;
  oldestInboundMessageId: string;
  oldestInboundAt: Date;
  /** Wall-clock minutes elapsed since the oldest unanswered inbound arrived. */
  elapsedMinutes: number;
  /** Business-hours minutes elapsed since the oldest unanswered inbound. */
  businessMinutesElapsed: number;
  gmailThreadUrl: string | null;
  /** OPEN or REPLIED if an R-01 alert exists for this thread; null otherwise. */
  r01AlertStatus: 'OPEN' | 'REPLIED' | null;
}

export interface AgingQueueFilters {
  mailboxAddress?: string;
  /** 'oldest_first' (default) or 'newest_first' */
  sortBy?: 'oldest_first' | 'newest_first';
  page: number;
  pageSize: number;
}

export interface AgingQueueResult {
  page: number;
  pageSize: number;
  totalCount: number;
  /** Days of history included; threads older than this may be missing. */
  lookbackDays: number;
  data: AgingQueueEntry[];
}

export interface AgingQueueSummary {
  mailboxAddress: string;
  unansweredThreadCount: number;
  oldestElapsedMinutes: number;
  oldestBusinessMinutes: number;
  averageElapsedMinutes: number;
  averageBusinessMinutes: number;
  /** null when r01ThresholdMinutes is not configured. */
  threadsOverR01Threshold: number | null;
}

export interface AgingQueueSummaryFilters {
  mailboxAddress?: string;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface RawGmailRow {
  mailbox_id?: string;
  provider_message_id: string;
  thread_id: string;
  internal_date: Date | null;
  mailbox_address: string;
  /** Only the metadata needed by classifyDirection is projected from JSONB. */
  label_ids?: unknown;
  headers?: unknown;
  /** Test/legacy fallback; production queries use label_ids and headers. */
  payload?: Record<string, unknown> | null;
}

interface MailboxRef {
  id?: string;
  address: string;
}

const R05_QUERY_TIMEOUT_MS = 15_000;
const R05_OPERATION_TIMEOUT_MS = 30_000;

const withR05Timeout = <T>(query: T): T => {
  const candidate = query as T & {
    timeout?: (milliseconds: number, options?: { cancel?: boolean }) => T;
  };
  return typeof candidate.timeout === 'function'
    ? candidate.timeout(R05_QUERY_TIMEOUT_MS, { cancel: true })
    : query;
};

interface ClassifiedMessage {
  providerId: string;
  internalDate: Date;
  direction: 'INBOUND' | 'OUTBOUND';
}

interface ThreadStateRow {
  mailbox_id: string;
  mailbox_address: string;
  thread_id: string;
  last_activity_at: Date;
  oldest_unanswered_message_id?: string | null;
  oldest_unanswered_at?: Date | null;
}

interface FactReadRow {
  mailbox_id: string;
  mailbox_address: string;
  thread_id: string;
  provider_message_id: string;
  internal_date: Date;
  direction: GmailMessageDirection;
}

const THREAD_STATE_JOB = 'R05_THREAD_STATE_V1';

// ---------------------------------------------------------------------------
// Core engine — computes unanswered entries for one mailbox
// ---------------------------------------------------------------------------

const computeAgingEntries = async (
  database: Knex,
  mailboxes: MailboxRef[],
  config: R05Config,
  now: Date,
  includeAlertStatus: boolean,
): Promise<AgingQueueEntry[]> => {
  const lookbackCutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
  const operationDeadline = Date.now() + R05_OPERATION_TIMEOUT_MS;
  const ensureWithinDeadline = () => {
    if (Date.now() > operationDeadline) throw new Error('R-05 aging queue computation timed out.');
  };

  if (mailboxes.length === 0) return [];
  const mailboxIds = mailboxes.map((mailbox) => mailbox.id).filter((id): id is string => id !== undefined);
  const mailboxAddresses = mailboxes.map((mailbox) => mailbox.address);
  let query = database('raw_gmail_messages')
    .select(
      'mailbox_id',
      'provider_message_id',
      'thread_id',
      'internal_date',
      'mailbox_address',
      database.raw("payload->'labelIds' AS label_ids"),
      database.raw("payload->'headers' AS headers"),
    )
    .where({ is_latest: true, is_deleted: false })
    .where('internal_date', '>=', lookbackCutoff);
  // The existing (mailbox_id, internal_date) index is selective here. The
  // address fallback preserves behavior for synthetic/legacy rows without a
  // resolvable mailbox record.
  query = mailboxIds.length === mailboxes.length
    ? query.whereIn('mailbox_id', mailboxIds)
    : query.whereIn('mailbox_address', mailboxAddresses);
  const rows = await withR05Timeout(query) as RawGmailRow[];
  ensureWithinDeadline();

  // Group by thread
  const threadMap = new Map<string, RawGmailRow[]>();
  for (const row of rows) {
    if (!row.thread_id) continue;
    const key = `${row.mailbox_address}\u0000${row.thread_id}`;
    const existing = threadMap.get(key) ?? [];
    existing.push(row);
    threadMap.set(key, existing);
  }

  const unanswered: AgingQueueEntry[] = [];

  let processedThreads = 0;
  for (const [key, threadRows] of threadMap) {
    if ((processedThreads++ & 0x3ff) === 0) ensureWithinDeadline();
    const mailboxAddress = threadRows[0]!.mailbox_address;
    const threadId = key.slice(key.indexOf('\u0000') + 1);
    const messages: ClassifiedMessage[] = [];
    for (const row of threadRows) {
      if (!row.internal_date) continue;
      const direction = classifyDirection(
        row.payload ?? { labelIds: row.label_ids, headers: row.headers },
        config.workspaceDomain,
      );
      if (direction === 'INBOUND' || direction === 'OUTBOUND') {
        messages.push({ providerId: row.provider_message_id, internalDate: row.internal_date, direction });
      }
    }
    messages.sort((a, b) => a.internalDate.getTime() - b.internalDate.getTime());

    const oldest = findOldestUnanswered(messages);
    if (oldest === null) continue; // thread is fully replied — excluded

    const agingStart = nextBusinessMoment(oldest.internalDate, config.businessCalendar);
    const busMinutes = businessMinutesElapsed(agingStart, now, config.businessCalendar);
    const elapsedMinutes = Math.floor((now.getTime() - oldest.internalDate.getTime()) / 60_000);

    unanswered.push({
      mailboxAddress,
      threadId,
      oldestInboundMessageId: oldest.providerId,
      oldestInboundAt: oldest.internalDate,
      elapsedMinutes,
      businessMinutesElapsed: busMinutes,
      gmailThreadUrl: `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(mailboxAddress)}#all/${threadId}`,
      r01AlertStatus: null, // populated below
    });
  }

  // Enrich with R-01 alert statuses in one batch query.
  if (includeAlertStatus && unanswered.length > 0) {
    const alertMap = new Map<string, 'OPEN' | 'REPLIED'>();
    const mailboxAddresses = [...new Set(unanswered.map((entry) => entry.mailboxAddress))];
    const threadIds = [...new Set(unanswered.map((entry) => entry.threadId))];
    const alerts = await withR05Timeout(database('google_unanswered_thread_alerts')
      .select('mailbox_address', 'thread_id', 'status')
      .whereIn('mailbox_address', mailboxAddresses)
      .whereIn('thread_id', threadIds)) as { mailbox_address: string; thread_id: string; status: string }[];
    for (const alert of alerts) alertMap.set(`${alert.mailbox_address}\u0000${alert.thread_id}`, alert.status as 'OPEN' | 'REPLIED');
    for (const entry of unanswered) entry.r01AlertStatus = alertMap.get(`${entry.mailboxAddress}\u0000${entry.threadId}`) ?? null;
  }

  return unanswered;
};

/**
 * Derived read path. A completed thread-state row already has
 * the exact unanswered message and timestamp needed by the summary.  Facts
 * are loaded only for the narrow ambiguity where that timestamp predates the
 * rolling lookback (the legacy path intentionally recomputes against facts in
 * the lookback window in that case).  This keeps the common path state-only
 * without changing the legacy lookback boundary.
 */
const computeAgingEntriesFromThreadStateOptimized = async (
  database: Knex,
  mailboxes: MailboxRef[],
  config: R05Config,
  now: Date,
  includeAlertStatus: boolean,
): Promise<AgingQueueEntry[]> => {
  if (mailboxes.length === 0) return [];
  const progress = await withR05Timeout(database('google_gmail_thread_state_backfill')
    .select('status').where({ job_name: THREAD_STATE_JOB }).first()) as { status?: string } | undefined;
  if (progress?.status !== 'COMPLETED') throw new R05BackfillIncompleteError();

  const mailboxIds = mailboxes.map((mailbox) => mailbox.id).filter((id): id is string => id !== undefined);
  if (mailboxIds.length !== mailboxes.length) return [];
  const cutoff = new Date(now.getTime() - config.lookbackDays * 24 * 60 * 60 * 1000);
  const businessMinutesForSummary = createBusinessMinutesCalculator(now, config.businessCalendar, cutoff);
  const states = await withR05Timeout(database('google_gmail_thread_responsiveness')
    .select(
      'mailbox_id', 'mailbox_address', 'thread_id', 'last_activity_at',
      'oldest_unanswered_message_id', 'oldest_unanswered_at',
    )
    .where({ has_unanswered: true })
    .where('last_activity_at', '>=', cutoff)
    .whereIn('mailbox_id', mailboxIds)) as ThreadStateRow[];
  if (states.length === 0) return [];

  const unanswered: AgingQueueEntry[] = [];
  const ambiguous = states.filter((state) => !state.oldest_unanswered_at || state.oldest_unanswered_at < cutoff);
  const stateOnly = states.filter((state) => state.oldest_unanswered_at && state.oldest_unanswered_at >= cutoff);
  const appendEntry = (state: ThreadStateRow, messageId: string, oldestAt: Date) => {
    const agingStart = nextBusinessMoment(oldestAt, config.businessCalendar);
    unanswered.push({
      mailboxAddress: state.mailbox_address,
      threadId: state.thread_id,
      oldestInboundMessageId: messageId,
      oldestInboundAt: oldestAt,
      elapsedMinutes: Math.floor((now.getTime() - oldestAt.getTime()) / 60_000),
      businessMinutesElapsed: businessMinutesForSummary(agingStart),
      gmailThreadUrl: `https://mail.google.com/mail/u/0/?authuser=${encodeURIComponent(state.mailbox_address)}#all/${state.thread_id}`,
      r01AlertStatus: null,
    });
  };
  for (const state of stateOnly) {
    if (state.oldest_unanswered_message_id && state.oldest_unanswered_at) {
      appendEntry(state, state.oldest_unanswered_message_id, state.oldest_unanswered_at);
    }
  }

  if (ambiguous.length > 0) {
    const ambiguousThreadIds = ambiguous.map((state) => state.thread_id);
    const facts = await withR05Timeout(database('google_gmail_message_facts')
      .select('mailbox_id', 'mailbox_address', 'thread_id', 'provider_message_id', 'internal_date', 'direction')
      .whereIn('mailbox_id', mailboxIds)
      .whereIn('thread_id', ambiguousThreadIds)
      .where('internal_date', '>=', cutoff)) as FactReadRow[];
    const byThread = new Map<string, FactReadRow[]>();
    for (const fact of facts) {
      const key = `${fact.mailbox_id}\u0000${fact.thread_id}`;
      const rows = byThread.get(key) ?? [];
      rows.push(fact);
      byThread.set(key, rows);
    }
    for (const state of ambiguous) {
      const key = `${state.mailbox_id}\u0000${state.thread_id}`;
      const recomputed = recomputeGmailThreadState(
        state.mailbox_id,
        state.mailbox_address,
        state.thread_id,
        (byThread.get(key) ?? []).map((fact) => ({
          mailboxId: fact.mailbox_id,
          mailboxAddress: fact.mailbox_address,
          threadId: fact.thread_id,
          providerMessageId: fact.provider_message_id,
          internalDate: fact.internal_date,
          direction: fact.direction,
        })),
      );
      if (recomputed?.oldestUnansweredMessageId && recomputed.oldestUnansweredAt) {
        appendEntry(state, recomputed.oldestUnansweredMessageId, recomputed.oldestUnansweredAt);
      }
    }
  }
  if (includeAlertStatus && unanswered.length > 0) {
    const alertRows = await withR05Timeout(database('google_unanswered_thread_alerts')
      .select('mailbox_address', 'thread_id', 'status')
      .whereIn('mailbox_address', [...new Set(unanswered.map((entry) => entry.mailboxAddress))])
      .whereIn('thread_id', [...new Set(unanswered.map((entry) => entry.threadId))])) as { mailbox_address: string; thread_id: string; status: string }[];
    const alertMap = new Map(alertRows.map((alert) => [`${alert.mailbox_address}\u0000${alert.thread_id}`, alert.status as 'OPEN' | 'REPLIED']));
    for (const entry of unanswered) entry.r01AlertStatus = alertMap.get(`${entry.mailboxAddress}\u0000${entry.threadId}`) ?? null;
  }
  return unanswered;
};

// ---------------------------------------------------------------------------
// Public API — thread detail list
// ---------------------------------------------------------------------------

export const listAgingQueue = async (
  database: Knex,
  filters: AgingQueueFilters,
  config: R05Config,
  now: Date = new Date(),
): Promise<AgingQueueResult> => {
  const mailboxes = await resolveMailboxes(database, filters.mailboxAddress);
  const allEntries = await (config.useThreadState
    ? computeAgingEntriesFromThreadStateOptimized(database, mailboxes, config, now, true)
    : computeAgingEntries(database, mailboxes, config, now, true));

  // Sort: oldest_first = highest elapsedMinutes first (default); newest_first = lowest first.
  const sorted = [...allEntries].sort((a, b) =>
    filters.sortBy === 'newest_first'
      ? a.elapsedMinutes - b.elapsedMinutes
      : b.elapsedMinutes - a.elapsedMinutes,
  );

  const { page, pageSize } = filters;
  const offset = (page - 1) * pageSize;
  const data = sorted.slice(offset, offset + pageSize);

  return { page, pageSize, totalCount: sorted.length, lookbackDays: config.lookbackDays, data };
};

// ---------------------------------------------------------------------------
// Public API — mailbox summary
// ---------------------------------------------------------------------------

export const agingQueueSummary = async (
  database: Knex,
  filters: AgingQueueSummaryFilters,
  config: R05Config,
  now: Date = new Date(),
): Promise<AgingQueueSummary[]> => {
  const mailboxes = await resolveMailboxes(database, filters.mailboxAddress);
  const results: AgingQueueSummary[] = [];

  const entriesByMailbox = new Map<string, AgingQueueEntry[]>();
  const entries = await (config.useThreadState
    ? computeAgingEntriesFromThreadStateOptimized(database, mailboxes, config, now, false)
    : computeAgingEntries(database, mailboxes, config, now, false));
  for (const entry of entries) {
    const entries = entriesByMailbox.get(entry.mailboxAddress) ?? [];
    entries.push(entry);
    entriesByMailbox.set(entry.mailboxAddress, entries);
  }
  for (const mailbox of mailboxes) {
    const mailboxAddress = mailbox.address;
    const entries = entriesByMailbox.get(mailboxAddress) ?? [];
    if (entries.length === 0) continue;

    const oldest = entries.reduce((a, b) => a.elapsedMinutes > b.elapsedMinutes ? a : b);
    const totalElapsed = entries.reduce((sum, e) => sum + e.elapsedMinutes, 0);
    const totalBusiness = entries.reduce((sum, e) => sum + e.businessMinutesElapsed, 0);
    const threadsOverR01Threshold = config.r01ThresholdMinutes !== undefined
      ? entries.filter((e) => e.businessMinutesElapsed >= config.r01ThresholdMinutes!).length
      : null;

    results.push({
      mailboxAddress,
      unansweredThreadCount: entries.length,
      oldestElapsedMinutes: oldest.elapsedMinutes,
      oldestBusinessMinutes: oldest.businessMinutesElapsed,
      averageElapsedMinutes: Math.floor(totalElapsed / entries.length),
      averageBusinessMinutes: Math.floor(totalBusiness / entries.length),
      threadsOverR01Threshold,
    });
  }

  return results;
};

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

const resolveMailboxes = async (database: Knex, mailboxAddress: string | undefined): Promise<MailboxRef[]> => {
  let query = database('google_gmail_mailboxes').select('id', 'normalized_mailbox_address').where({ enabled: true });
  if (mailboxAddress !== undefined) query = query.where({ normalized_mailbox_address: mailboxAddress });
  const rows = await withR05Timeout(query) as Array<{ id?: string; normalized_mailbox_address: string }>;
  if (rows.length > 0) return rows.map((row) => ({
    ...(row.id !== undefined ? { id: row.id } : {}),
    address: row.normalized_mailbox_address,
  }));
  // Preserve the prior explicit-filter behavior for an unknown/disabled address.
  return mailboxAddress === undefined ? [] : [{ address: mailboxAddress }];
};

// Singleton — imported by google.routes.ts; uses the application-level knex instance.
export const r05Db = db;
