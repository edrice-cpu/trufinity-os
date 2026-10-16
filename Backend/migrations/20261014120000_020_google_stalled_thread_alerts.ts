import type { Knex } from 'knex';

// R-02: Stalled Thread Detection
//
// Stores one row per (mailbox, thread, stall_reason). Each reason is tracked
// independently so Condition A (inactivity) and Condition B (excessive exchanges)
// can open and close without affecting each other.
//
// stall_reason values:
//   INACTIVITY           — no classified message activity for >= threshold minutes
//   EXCESSIVE_EXCHANGES  — thread has reached the message-count threshold and a
//                          phone-call follow-up is recommended
//
// status values:
//   OPEN     — condition currently detected, awaiting resolution
//   RESOLVED — condition no longer meets the detection criterion on re-evaluation
//
// Precedence note (unresolved — see implementation gap docs):
//   R-01 (google_unanswered_thread_alerts) and R-02 (this table) are independent.
//   An OPEN R-01 alert may coexist with an R-02 INACTIVITY alert on the same thread.
//   Automatic cross-table suppression has NOT been implemented pending product
//   confirmation of the desired precedence behaviour.

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_stalled_thread_alerts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('mailbox_address').notNullable();
    table.text('thread_id').notNullable();
    // Which condition triggered this alert (independent per reason).
    table.text('stall_reason').notNullable()
      .checkIn(['INACTIVITY', 'EXCESSIVE_EXCHANGES'], 'google_stalled_thread_alerts_reason_check');
    // Most recent classified (INBOUND or OUTBOUND) message timestamp at detection time.
    table.timestamp('last_interaction_at', { useTz: true }).notNullable();
    // For INACTIVITY: minutes since last_interaction_at at last evaluation (null for EXCESSIVE_EXCHANGES).
    table.integer('inactivity_minutes').nullable();
    // Total classified message count in this thread at last evaluation.
    table.integer('message_count').notNullable().defaultTo(0);
    // True when message_count >= the configured phone-call recommendation threshold.
    table.boolean('phone_call_recommended').notNullable().defaultTo(false);
    // Threshold values captured at creation so they remain interpretable if env vars change.
    table.integer('inactivity_threshold_minutes').nullable();
    table.integer('message_count_threshold').notNullable();
    // UTC instant when the condition was first detected (set on first insert; never updated).
    table.timestamp('threshold_exceeded_at', { useTz: true }).notNullable();
    table.text('status').notNullable()
      .checkIn(['OPEN', 'RESOLVED'], 'google_stalled_thread_alerts_status_check');
    table.timestamp('resolved_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // Idempotency: one alert per (mailbox, thread, reason). Each reason has its own lifecycle.
    table.unique(
      ['mailbox_address', 'thread_id', 'stall_reason'],
      { indexName: 'google_stalled_thread_alerts_cycle_key' },
    );
  });

  // Fast lookup for open alerts by mailbox (worker re-evaluation).
  await knex.raw(`
    CREATE INDEX google_stalled_thread_alerts_open_mailbox_idx
      ON google_stalled_thread_alerts (mailbox_address)
      WHERE status = 'OPEN'
  `);

  // Thread-level lookup for cross-table precedence checks (future use).
  await knex.raw(`
    CREATE INDEX google_stalled_thread_alerts_thread_idx
      ON google_stalled_thread_alerts (mailbox_address, thread_id)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS google_stalled_thread_alerts_thread_idx');
  await knex.raw('DROP INDEX IF EXISTS google_stalled_thread_alerts_open_mailbox_idx');
  await knex.schema.dropTableIfExists('google_stalled_thread_alerts');
}
