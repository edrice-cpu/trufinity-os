import type { Knex } from 'knex';

// R-01: Unanswered Inbound Email Detection
//
// Stores one row per "unanswered reply cycle" per (mailbox, thread).
// A cycle is identified by the oldest still-unanswered inbound message in that
// thread segment. When the thread is replied to and a new inbound arrives, the
// oldest_unanswered_message_id changes, making the unique key different and
// allowing a fresh row for the new cycle without touching the closed one.
//
// Statuses:
//   OPEN    — threshold exceeded, awaiting reply
//   REPLIED — a later outbound was detected in the same thread
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_unanswered_thread_alerts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('mailbox_address').notNullable();
    table.text('thread_id').notNullable();
    // provider_message_id of the oldest unanswered inbound in this cycle.
    table.text('oldest_unanswered_message_id').notNullable();
    table.timestamp('oldest_unanswered_at', { useTz: true }).notNullable();
    // UTC instant when the threshold was first exceeded (set on first insert; never updated).
    table.timestamp('threshold_exceeded_at', { useTz: true }).notNullable();
    // Snapshot of business minutes elapsed at last evaluation (updated each cycle).
    table.integer('business_minutes_elapsed').notNullable().defaultTo(0);
    // Threshold captured at creation so it remains interpretable if the env var changes.
    table.integer('threshold_minutes').notNullable();
    table.text('status').notNullable()
      .checkIn(['OPEN', 'REPLIED'], 'google_unanswered_thread_alerts_status_check');
    table.timestamp('replied_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Idempotency: one alert per (mailbox, thread, oldest-pending-inbound).
    table.unique(
      ['mailbox_address', 'thread_id', 'oldest_unanswered_message_id'],
      { indexName: 'google_unanswered_thread_alerts_cycle_key' },
    );
  });

  // Partial index for the common worker lookup: OPEN alerts by mailbox.
  await knex.raw(`
    CREATE INDEX google_unanswered_thread_alerts_open_mailbox_idx
      ON google_unanswered_thread_alerts (mailbox_address)
      WHERE status = 'OPEN'
  `);

  // Index for thread lookups (closing alerts when a reply is detected).
  await knex.raw(`
    CREATE INDEX google_unanswered_thread_alerts_thread_idx
      ON google_unanswered_thread_alerts (mailbox_address, thread_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS google_unanswered_thread_alerts_thread_idx');
  await knex.raw('DROP INDEX IF EXISTS google_unanswered_thread_alerts_open_mailbox_idx');
  await knex.schema.dropTableIfExists('google_unanswered_thread_alerts');
}
