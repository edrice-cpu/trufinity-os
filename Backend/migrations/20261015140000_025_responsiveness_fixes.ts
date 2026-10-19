import type { Knex } from 'knex';

/**
 * Migration 025 — Phase 4.1 responsiveness notification fixes
 *
 * Fix 1: next_attempt_at — exponential backoff tracking for FAILED rows.
 *   claim() now also accepts FAILED rows whose next_attempt_at has passed.
 *   markFailed() sets next_attempt_at = now + 2^(attempt_count-1) minutes.
 *   lease_token fences claims so stale senders cannot update a newer claim.
 *
 * Fix 4: notification_generation — lifecycle deduplication for R-02/R-04.
 *   R-02 and R-04 alert rows reuse the same UUID on RESOLVED→OPEN transitions.
 *   notification_generation (default 1) is incremented on each RESOLVED→OPEN
 *   transition, producing a new idempotency key and re-enabling notification.
 *   Idempotency key format (updated):
 *     responsiveness:{alert_type_lower}:{alert_id}:{generation}:{recipient}
 *
 * Fix 5: is_emergency — explicit emergency flag for R-01 alerts.
 *   Replaces the fragile `threshold_minutes <= 25` heuristic in the notifier.
 *   Persisted by R-01 upsertAlert() from the isEmergencyClassified() result.
 *
 * DO NOT EXECUTE — execute only during a supervised migration window after
 * Daniel/ops approval.
 */
export async function up(knex: Knex): Promise<void> {
  // Fix 5: explicit is_emergency flag on R-01 alert table
  await knex.schema.alterTable('google_unanswered_thread_alerts', (t) => {
    t.boolean('is_emergency').notNullable().defaultTo(false);
  });

  // Fix 4: notification_generation for lifecycle deduplication on R-02 alert table
  await knex.schema.alterTable('google_stalled_thread_alerts', (t) => {
    t.integer('notification_generation').notNullable().defaultTo(1);
  });

  // Fix 4: notification_generation for lifecycle deduplication on R-04 alert table
  await knex.schema.alterTable('google_after_hours_backlog_alerts', (t) => {
    t.integer('notification_generation').notNullable().defaultTo(1);
  });

  // Fix 1: next_attempt_at for exponential-backoff retry of FAILED notifications
  await knex.schema.alterTable('google_responsiveness_notifications', (t) => {
    t.timestamp('next_attempt_at', { useTz: true }).nullable()
      .comment('Earliest UTC time at which a FAILED row may be retried (exponential backoff)');
    t.text('lease_token').nullable()
      .comment('Fencing token for the current SENDING claim');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('google_responsiveness_notifications', (t) => {
    t.dropColumn('lease_token');
    t.dropColumn('next_attempt_at');
  });
  await knex.schema.alterTable('google_after_hours_backlog_alerts', (t) => {
    t.dropColumn('notification_generation');
  });
  await knex.schema.alterTable('google_stalled_thread_alerts', (t) => {
    t.dropColumn('notification_generation');
  });
  await knex.schema.alterTable('google_unanswered_thread_alerts', (t) => {
    t.dropColumn('is_emergency');
  });
}
