import type { Knex } from 'knex';

/**
 * Migration 021 — google_reply_latency_records
 *
 * Stores individual inbound→reply latency measurements for R-03.
 * Each row represents one completed reply to one inbound message.
 *
 * Idempotency key: (mailbox_address, thread_id, inbound_message_id)
 * — re-evaluation of the same reply upserts (never duplicates).
 *
 * DO NOT EXECUTE — production DB is shared. Execute only during a
 * supervised migration window after Daniel/ops approval.
 */
export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('google_reply_latency_records', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('mailbox_address').notNullable();
    t.text('thread_id').notNullable();
    // Provider message IDs from raw_gmail_messages.provider_message_id
    t.text('inbound_message_id').notNullable();
    t.text('reply_message_id').notNullable();
    t.timestamp('inbound_at', { useTz: true }).notNullable();
    t.timestamp('replied_at', { useTz: true }).notNullable();
    t.integer('business_minutes_elapsed').notNullable();
    // ON_TIME: elapsed <= threshold; LATE: elapsed > threshold
    t.text('status').notNullable().checkIn(['ON_TIME', 'LATE']);
    // Snapshot of threshold at measurement time — survives config changes
    t.integer('threshold_minutes').notNullable();
    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Idempotency: one record per inbound message per mailbox/thread
    t.unique(['mailbox_address', 'thread_id', 'inbound_message_id']);
  });

  // Fast dashboard filter on LATE records
  await knex.schema.raw(`
    CREATE INDEX google_reply_latency_records_late_idx
    ON google_reply_latency_records (mailbox_address, inbound_at DESC)
    WHERE status = 'LATE'
  `);

  // Thread-level lookups
  await knex.schema.raw(`
    CREATE INDEX google_reply_latency_records_thread_idx
    ON google_reply_latency_records (mailbox_address, thread_id)
  `);

  // Time-range queries for reporting
  await knex.schema.raw(`
    CREATE INDEX google_reply_latency_records_inbound_at_idx
    ON google_reply_latency_records (mailbox_address, inbound_at DESC)
  `);
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('google_reply_latency_records');
};
