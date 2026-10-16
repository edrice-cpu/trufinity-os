import type { Knex } from 'knex';
import { classifyDirection } from './responsiveness-rule-r01';
import { TRUFINITY_WORKSPACE_DOMAIN } from './workspace-directory.service';

export type GmailMessageDirection = 'INBOUND' | 'OUTBOUND' | 'UNKNOWN';

export interface GmailMessageFactInput {
  mailboxId: string;
  mailboxAddress: string;
  providerMessageId: string;
  threadId: string;
  internalDate: Date;
  payload: Record<string, unknown> | null;
  isDeleted: boolean;
}

export interface GmailMessageFact {
  mailboxId: string;
  mailboxAddress: string;
  providerMessageId: string;
  threadId: string;
  internalDate: Date;
  direction: GmailMessageDirection;
}

export interface GmailThreadState {
  mailboxId: string;
  mailboxAddress: string;
  threadId: string;
  lastActivityAt: Date;
  lastOutboundMessageId: string | null;
  lastOutboundAt: Date | null;
  oldestUnansweredMessageId: string | null;
  oldestUnansweredAt: Date | null;
  classifiedMessageCount: number;
  messageCount: number;
  hasUnanswered: boolean;
}

/**
 * The direction classifier reads only these two metadata members. Keeping the
 * projection explicit makes the backfill SQL projection auditable and gives
 * tests a direct equivalence contract for payload minimization.
 */
export const projectGmailDirectionMetadata = (
  payload: Record<string, unknown> | null,
): Record<string, unknown> | null => payload === null ? null : {
  labelIds: payload.labelIds,
  headers: payload.headers,
};

/** Extracts only direction metadata; Gmail content never enters the facts table. */
export const extractGmailMessageFact = (
  input: GmailMessageFactInput,
  workspaceDomain = TRUFINITY_WORKSPACE_DOMAIN,
): GmailMessageFact | null => {
  if (input.isDeleted || input.threadId.trim() === '') return null;
  const direction = classifyDirection(projectGmailDirectionMetadata(input.payload), workspaceDomain);
  return {
    mailboxId: input.mailboxId,
    mailboxAddress: input.mailboxAddress,
    providerMessageId: input.providerMessageId,
    threadId: input.threadId,
    internalDate: input.internalDate,
    direction,
  };
};

/**
 * Recomputes the exact current-thread state from narrow metadata facts.
 * Unknown-direction messages still count as activity, matching R05's inclusion
 * behavior, while only inbound/outbound messages participate in unanswered logic.
 */
export const recomputeGmailThreadState = (
  mailboxId: string,
  mailboxAddress: string,
  threadId: string,
  facts: readonly GmailMessageFact[],
): GmailThreadState | null => {
  if (facts.length === 0) return null;
  const ordered = [...facts].sort((a, b) => {
    const byDate = a.internalDate.getTime() - b.internalDate.getTime();
    return byDate !== 0 ? byDate : a.providerMessageId.localeCompare(b.providerMessageId);
  });
  const classified = ordered.filter((fact) => fact.direction !== 'UNKNOWN');
  let lastOutbound: GmailMessageFact | null = null;
  for (const fact of classified) if (fact.direction === 'OUTBOUND') lastOutbound = fact;
  const pending = classified.filter((fact) =>
    fact.direction === 'INBOUND' && (lastOutbound === null || fact.internalDate > lastOutbound.internalDate),
  );
  const oldest = pending[0] ?? null;
  const lastActivity = ordered[ordered.length - 1]!;
  return {
    mailboxId,
    mailboxAddress,
    threadId,
    lastActivityAt: lastActivity.internalDate,
    lastOutboundMessageId: lastOutbound?.providerMessageId ?? null,
    lastOutboundAt: lastOutbound?.internalDate ?? null,
    oldestUnansweredMessageId: oldest?.providerMessageId ?? null,
    oldestUnansweredAt: oldest?.internalDate ?? null,
    classifiedMessageCount: classified.length,
    messageCount: ordered.length,
    hasUnanswered: oldest !== null,
  };
};

interface FactRow {
  mailbox_id: string;
  mailbox_address: string;
  thread_id: string;
  provider_message_id: string;
  internal_date: Date;
  direction: GmailMessageDirection;
}

const applyThreadFilter = <T extends { where: (...args: any[]) => T }>(query: T, keys: readonly { mailboxId: string; threadId: string }[]): T => {
  query.where((builder: any) => {
    keys.forEach((key, index) => {
      const clause = index === 0 ? builder.where : builder.orWhere;
      clause.call(builder, { mailbox_id: key.mailboxId, thread_id: key.threadId });
    });
  });
  return query;
};

const threadStateValues = (state: GmailThreadState, now: unknown) => ({
  mailbox_id: state.mailboxId,
  mailbox_address: state.mailboxAddress,
  thread_id: state.threadId,
  last_activity_at: state.lastActivityAt,
  last_outbound_message_id: state.lastOutboundMessageId,
  last_outbound_at: state.lastOutboundAt,
  oldest_unanswered_message_id: state.oldestUnansweredMessageId,
  oldest_unanswered_at: state.oldestUnansweredAt,
  classified_message_count: state.classifiedMessageCount,
  message_count: state.messageCount,
  has_unanswered: state.hasUnanswered,
  updated_at: now,
});

/** Refreshes multiple affected threads with one fact read and batched state writes. */
export const refreshGmailThreadStates = async (
  trx: Knex.Transaction,
  keys: readonly { mailboxId: string; threadId: string }[],
): Promise<number> => {
  const uniqueKeys = [...new Map(keys
    .filter((key) => key.threadId.trim() !== '')
    .map((key) => [`${key.mailboxId}:${key.threadId}`, key])).values()];
  if (uniqueKeys.length === 0) return 0;

  const rows = await applyThreadFilter(
    trx('google_gmail_message_facts').select(
      'mailbox_id', 'mailbox_address', 'thread_id', 'provider_message_id', 'internal_date', 'direction',
    ),
    uniqueKeys,
  ) as FactRow[];
  const byThread = new Map<string, GmailMessageFact[]>();
  const mailboxAddressByThread = new Map<string, string>();
  for (const row of rows) {
    const key = `${row.mailbox_id}:${row.thread_id}`;
    mailboxAddressByThread.set(key, row.mailbox_address);
    const facts = byThread.get(key) ?? [];
    facts.push({
      mailboxId: row.mailbox_id,
      mailboxAddress: row.mailbox_address,
      threadId: row.thread_id,
      providerMessageId: row.provider_message_id,
      internalDate: row.internal_date,
      direction: row.direction,
    });
    byThread.set(key, facts);
  }

  await applyThreadFilter(trx('google_gmail_thread_responsiveness'), uniqueKeys).delete();
  const states = uniqueKeys
    .map((key) => recomputeGmailThreadState(
      key.mailboxId,
      mailboxAddressByThread.get(`${key.mailboxId}:${key.threadId}`) ?? '',
      key.threadId,
      byThread.get(`${key.mailboxId}:${key.threadId}`) ?? [],
    ))
    .filter((state): state is GmailThreadState => state !== null);
  const values = states.map((state) => threadStateValues(state, trx.fn.now()));
  for (let index = 0; index < values.length; index += 500) {
    const chunk = values.slice(index, index + 500);
    if (chunk.length === 0) continue;
    await trx('google_gmail_thread_responsiveness')
      .insert(chunk)
      .onConflict(['mailbox_id', 'thread_id'])
      .merge();
  }
  return states.length;
};

/** Refreshes only affected threads inside the caller's existing transaction. */
export const refreshGmailThreadState = async (
  trx: Knex.Transaction,
  mailboxId: string,
  affectedThreadIds: Iterable<string>,
): Promise<void> => {
  for (const threadId of new Set([...affectedThreadIds].filter((id) => id.trim() !== ''))) {
    const rows = await trx('google_gmail_message_facts')
      .select(
        'mailbox_id',
        'mailbox_address',
        'thread_id',
        'provider_message_id',
        'internal_date',
        'direction',
      )
      .where({ mailbox_id: mailboxId, thread_id: threadId }) as FactRow[];
    const first = rows[0];
    const state = first
      ? recomputeGmailThreadState(
        mailboxId,
        first.mailbox_address,
        threadId,
        rows.map((row) => ({
          mailboxId: row.mailbox_id,
          mailboxAddress: row.mailbox_address,
          providerMessageId: row.provider_message_id,
          threadId: row.thread_id,
          internalDate: row.internal_date,
          direction: row.direction,
        })),
      )
      : null;

    if (!state) {
      await trx('google_gmail_thread_responsiveness')
        .where({ mailbox_id: mailboxId, thread_id: threadId })
        .delete();
      continue;
    }

    await trx('google_gmail_thread_responsiveness')
      .insert({
        mailbox_id: state.mailboxId,
        mailbox_address: state.mailboxAddress,
        thread_id: state.threadId,
        last_activity_at: state.lastActivityAt,
        last_outbound_message_id: state.lastOutboundMessageId,
        last_outbound_at: state.lastOutboundAt,
        oldest_unanswered_message_id: state.oldestUnansweredMessageId,
        oldest_unanswered_at: state.oldestUnansweredAt,
        classified_message_count: state.classifiedMessageCount,
        message_count: state.messageCount,
        has_unanswered: state.hasUnanswered,
        updated_at: trx.fn.now(),
      })
      .onConflict(['mailbox_id', 'thread_id'])
      .merge({
        mailbox_address: state.mailboxAddress,
        last_activity_at: state.lastActivityAt,
        last_outbound_message_id: state.lastOutboundMessageId,
        last_outbound_at: state.lastOutboundAt,
        oldest_unanswered_message_id: state.oldestUnansweredMessageId,
        oldest_unanswered_at: state.oldestUnansweredAt,
        classified_message_count: state.classifiedMessageCount,
        message_count: state.messageCount,
        has_unanswered: state.hasUnanswered,
        updated_at: trx.fn.now(),
      });
  }
};

export const upsertGmailMessageFact = async (
  trx: Knex.Transaction,
  fact: GmailMessageFact | null,
): Promise<void> => {
  if (!fact) return;
  await trx('google_gmail_message_facts')
    .insert({
      mailbox_id: fact.mailboxId,
      mailbox_address: fact.mailboxAddress,
      thread_id: fact.threadId,
      provider_message_id: fact.providerMessageId,
      internal_date: fact.internalDate,
      direction: fact.direction,
      updated_at: trx.fn.now(),
    })
    .onConflict(['mailbox_id', 'provider_message_id'])
    .merge({
      mailbox_address: fact.mailboxAddress,
      thread_id: fact.threadId,
      internal_date: fact.internalDate,
      direction: fact.direction,
      updated_at: trx.fn.now(),
    });
};

export const deleteGmailMessageFact = async (
  trx: Knex.Transaction,
  mailboxId: string,
  providerMessageId: string,
): Promise<void> => {
  await trx('google_gmail_message_facts')
    .where({ mailbox_id: mailboxId, provider_message_id: providerMessageId })
    .delete();
};

/** Rebuilds one thread's facts from a caller-owned transaction snapshot. */
export const replaceGmailThreadFacts = async (
  trx: Knex.Transaction,
  mailboxId: string,
  threadId: string,
  inputs: readonly GmailMessageFactInput[],
): Promise<void> => {
  await trx('google_gmail_message_facts')
    .where({ mailbox_id: mailboxId, thread_id: threadId })
    .delete();
  for (const input of inputs) {
    await upsertGmailMessageFact(trx, extractGmailMessageFact(input));
  }
};
