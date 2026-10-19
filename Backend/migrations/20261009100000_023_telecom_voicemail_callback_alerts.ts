import type { Knex } from 'knex';

// Creates telecom_voicemail_callback_alerts — per-voicemail alert table for D-02a
// (After-Hours Voicemail & Missing Callback Detection).
//
// Each row tracks one inbound after-hours voicemail call from ServiceTitan V3.
//
// Lifecycle:
//   OPEN        — callback deadline exceeded without a detected outbound attempt.
//   RESOLVED    — a subsequent outbound call to the same customer was found.
//   UNVERIFIABLE — callback cannot be assessed (no st_customer_id, stale data).
//
// Idempotency: unique on (source_system, source_id) — one row per V3 call ID.
// Safe to re-evaluate: upserts update elapsed/status without duplicating rows.
//
// Privacy: no phone numbers, audio, transcripts, or recording/voicemail URLs stored.
// The voicemail URL from v3_payload is never surfaced here — only its presence
// is used as the detection signal upstream.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('telecom_voicemail_callback_alerts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source identity — scoped to tenant via source_system including tenant ID
    table.string('source_system').notNullable();
    // V3 call source_id (from st_calls_v3_enrichment.source_id)
    table.string('source_id').notNullable();

    // Customer linkage — may be null for anonymous/unidentified callers
    table.string('st_customer_id').nullable();

    // Voicemail event timestamp (call_received_on from V3 enrichment)
    table.timestamp('voicemail_at', { useTz: true }).notNullable();

    // When the business-minutes threshold was first exceeded
    table.timestamp('threshold_exceeded_at', { useTz: true }).nullable();

    // Configured threshold in business minutes at time of detection
    table.integer('threshold_minutes').notNullable();

    // Business minutes elapsed from voicemail aging start to last evaluation
    table.integer('business_minutes_elapsed').notNullable().defaultTo(0);

    // Alert state
    // CHECK constraint enforced in DB; TypeScript enum enforced in application layer
    table.text('status').notNullable().defaultTo('OPEN');

    // Timestamp of the outbound call found as evidence of callback (RESOLVED only)
    table.timestamp('callback_at', { useTz: true }).nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // Enforce valid status values
  await knex.raw(`
    ALTER TABLE telecom_voicemail_callback_alerts
      ADD CONSTRAINT chk_telecom_vm_alert_status
        CHECK (status IN ('OPEN', 'RESOLVED', 'UNVERIFIABLE'))
  `);

  // Primary idempotency key: one alert row per voicemail call
  await knex.raw(`
    CREATE UNIQUE INDEX idx_telecom_vm_alert_source
      ON telecom_voicemail_callback_alerts (source_system, source_id)
  `);

  // Query-layer: find OPEN alerts for re-evaluation sweep
  await knex.raw(`
    CREATE INDEX idx_telecom_vm_alert_status
      ON telecom_voicemail_callback_alerts (status, source_system)
      WHERE status = 'OPEN'
  `);

  // Query-layer: customer-based lookups for callback correlation
  await knex.raw(`
    CREATE INDEX idx_telecom_vm_alert_customer
      ON telecom_voicemail_callback_alerts (st_customer_id, source_system)
      WHERE st_customer_id IS NOT NULL
  `);

  // Query-layer: time-range scans for the lookback window
  await knex.raw(`
    CREATE INDEX idx_telecom_vm_alert_voicemail_at
      ON telecom_voicemail_callback_alerts (source_system, voicemail_at)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('telecom_voicemail_callback_alerts');
}
