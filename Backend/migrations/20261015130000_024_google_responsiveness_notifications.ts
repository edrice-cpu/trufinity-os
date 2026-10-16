import type { Knex } from 'knex';

/**
 * Migration 024 — google_responsiveness_notifications
 *
 * Delivery ledger for responsiveness-rule email notifications (R-01, R-02, R-04).
 * Separate from email_notification_deliveries (which is tightly coupled to
 * email_escalation_work_items via a NOT NULL FK and cannot be reused here).
 *
 * ALERT TYPES AND PRIORITY ORDER (proposed, pending Daniel approval):
 *   1. R01_EMERGENCY          — unanswered inbound, 25-min emergency threshold
 *   2. R01_GENERAL            — unanswered inbound, standard business-hours threshold
 *   3. R04_AFTER_HOURS        — after-hours backlog
 *   4. R02_INACTIVITY         — 24-coverage-hour stall
 *   5. R02_EXCESSIVE_EXCHANGES — high message-count stall
 *
 * IDEMPOTENCY KEY FORMAT:
 *   responsiveness:{alert_type_lower}:{alert_id}:{recipient}
 *   Each alert UUID is unique per lifecycle. For R-01, a new oldest-message
 *   creates a new UUID → fresh notification eligibility. For R-02/R-04, the
 *   same row UUID is reused on RESOLVED→OPEN transitions, so a notification
 *   already SENT for that alert won't re-fire (known limitation; document only).
 *
 * LEASE RECOVERY:
 *   Rows stuck in SENDING for > 10 minutes (crashed worker) are eligible for
 *   recoverPending(); they are reclaimed and reattempted up to max_attempts.
 *
 * DEPLOY ORDER:
 *   1. Run this migration.
 *   2. Deploy application code with the responsiveness-notifier module.
 *   3. Set GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=TEST (with a test recipient).
 *   4. Verify a test notification is received.
 *   5. Set GOOGLE_RESPONSIVENESS_NOTIFICATION_MODE=PRODUCTION (with gate) only
 *      after Daniel explicitly approves the priority policy and recipient list.
 *
 * DO NOT EXECUTE — production DB is shared. Execute only during a supervised
 * migration window after Daniel/ops approval.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_responsiveness_notifications', (t) => {
    t.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Which alert table and row generated this notification
    t.text('alert_table').notNullable()
      .comment('google_unanswered_thread_alerts | google_stalled_thread_alerts | google_after_hours_backlog_alerts');
    t.uuid('alert_id').notNullable()
      .comment('UUID of the specific alert row (no FK — polymorphic across three tables)');
    t.text('alert_type').notNullable()
      .comment('R01_EMERGENCY | R01_GENERAL | R04_AFTER_HOURS | R02_INACTIVITY | R02_EXCESSIVE_EXCHANGES');

    // Thread context (for cross-rule deduplication and email content)
    t.text('mailbox_address').notNullable();
    t.text('thread_id').notNullable();

    // Delivery state
    t.text('recipient').notNullable();
    t.text('status').notNullable().defaultTo('PENDING')
      .comment('PENDING | SENDING | SENT | FAILED');
    t.integer('attempt_count').notNullable().defaultTo(0);
    t.integer('max_attempts').notNullable().defaultTo(5);
    t.timestamp('last_attempted_at', { useTz: true }).nullable();
    t.timestamp('sent_at', { useTz: true }).nullable();
    t.text('last_error_category').nullable()
      .comment('SMTP_CONNECT | SMTP_AUTH | SMTP_SEND | UNKNOWN');

    // Idempotency: one notification per (alert lifecycle, recipient)
    t.text('idempotency_key').notNullable().unique()
      .comment('responsiveness:{alert_type_lower}:{alert_id}:{recipient}');

    t.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    t.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    ALTER TABLE google_responsiveness_notifications
      ADD CONSTRAINT grn_alert_type_check
      CHECK (alert_type IN ('R01_EMERGENCY','R01_GENERAL','R04_AFTER_HOURS','R02_INACTIVITY','R02_EXCESSIVE_EXCHANGES'))
  `);

  await knex.raw(`
    ALTER TABLE google_responsiveness_notifications
      ADD CONSTRAINT grn_status_check
      CHECK (status IN ('PENDING','SENDING','SENT','FAILED'))
  `);

  // Fast lookup for: "has this alert already been notified?"
  await knex.schema.table('google_responsiveness_notifications', (t) => {
    t.index(['alert_id', 'recipient'], 'grn_alert_recipient_idx');
    t.index(['mailbox_address', 'thread_id', 'status'], 'grn_mailbox_thread_status_idx');
    // Lease recovery index: SENDING rows older than the lease window
    t.index(['status', 'last_attempted_at'], 'grn_status_last_attempted_idx');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('google_responsiveness_notifications');
}
