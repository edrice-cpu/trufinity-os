import type { Knex } from 'knex';

export const up = async (knex: Knex): Promise<void> => {
  await knex.schema.createTable('google_after_hours_backlog_alerts', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    t.text('mailbox_address').notNullable();
    t.text('thread_id').notNullable();
    // The oldest unanswered inbound message that arrived during after-hours coverage.
    t.text('inbound_message_id').notNullable();
    t.timestamp('inbound_at', { useTz: true }).notNullable();
    // next business opening + grace_minutes (60 min) — pre-computed at upsert time.
    t.timestamp('deadline_at', { useTz: true }).notNullable();
    t.text('status').notNullable().checkIn(['OPEN', 'RESOLVED']);
    t.timestamp('resolved_at', { useTz: true }).nullable();
    t.timestamp('created_at', { useTz: true }).notNullable();
    t.timestamp('updated_at', { useTz: true }).notNullable();

    // Each after-hours inbound trigger produces at most one alert record.
    t.unique(['mailbox_address', 'thread_id', 'inbound_message_id']);
  });

  // Partial index — OPEN alerts are the hot path for the worker re-evaluation loop.
  await knex.raw(`
    CREATE INDEX idx_after_hours_backlog_open
      ON google_after_hours_backlog_alerts (mailbox_address, updated_at DESC)
      WHERE status = 'OPEN'
  `);

  // Thread-level lookup for fast OPEN→RESOLVED transitions.
  await knex.schema.table('google_after_hours_backlog_alerts', (t) => {
    t.index(['mailbox_address', 'thread_id'], 'idx_after_hours_backlog_thread');
  });

  // Time-range index for dashboard queries filtering by inbound_at.
  await knex.schema.table('google_after_hours_backlog_alerts', (t) => {
    t.index(['mailbox_address', 'inbound_at'], 'idx_after_hours_backlog_time');
  });
};

export const down = async (knex: Knex): Promise<void> => {
  await knex.schema.dropTableIfExists('google_after_hours_backlog_alerts');
};
