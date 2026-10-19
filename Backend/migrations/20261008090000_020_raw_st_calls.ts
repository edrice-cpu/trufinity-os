import type { Knex } from 'knex';

// Creates raw_st_calls — the raw-layer table for ServiceTitan Telecom export records.
//
// Source: GET /telecom/v2/tenant/{tenant}/export/calls
// Verified live: HTTP 200, 3,570 records per 30-day window, continueFrom populated.
//
// Schema notes:
//   - source_id = ST call `id` (numeric). ST call IDs are NOT unique across
//     tenants (multi-tenant platform). source_system + source_id enforces the
//     uniqueness boundary. The ingestion lock key is scoped to tenant too.
//   - payload = verbatim export record JSONB. Includes from/to phone numbers and
//     recordingUrl — treated as raw data retained for processing, not displayed.
//   - recording_url / voicemail_path are NOT surfaced here; they live inside payload
//     only. Do not create separate columns for them — avoids accidental exposure in
//     SQL queries and keeps the schema stable if ST changes the URL structure.
//   - No transcript or audio content is stored.
//
// Unique indexes:
//   - (source_system, source_id) WHERE is_latest — one active row per call
//   - (source_system, source_id, ingested_at) — history uniqueness (mirrors existing raw tables)
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('raw_st_calls', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source identity — scoped to tenant via source_system including tenant ID
    table.string('source_system').notNullable();
    table.string('source_id').notNullable();

    // Indexed call attributes for query-layer access without JSON extraction
    table.string('direction').nullable();          // 'Inbound' | 'Outbound'
    table.string('call_status').nullable();        // e.g. 'Completed', 'Missed'
    table.string('call_type').nullable();          // 'Lead', 'NonLead', etc.
    table.string('duration').nullable();           // ISO-8601 duration or seconds string per API
    // call_received_on intentionally omitted: the export record provides createdOn
    // and modifiedOn but the mapping to the actual call-received timestamp is
    // unverified. A future migration will add this column once the correct source
    // field is confirmed (likely from the list API's leadCall.receivedOn).
    table.timestamp('created_on', { useTz: true }).nullable();
    table.timestamp('modified_on', { useTz: true }).nullable();

    // Foreign-key references stored as string IDs (no FK constraint — raw layer)
    table.string('st_customer_id').nullable();
    table.string('st_location_id').nullable();
    table.string('st_job_id').nullable();
    table.string('st_campaign_id').nullable();
    table.string('st_agent_id').nullable();
    table.string('st_business_unit_id').nullable();

    // Raw payload — verbatim API response including from/to/recordingUrl
    table.jsonb('payload').notNullable();

    // Versioning / ingestion metadata (follows existing raw-table convention)
    table.boolean('is_latest').notNullable().defaultTo(true);
    table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
  });

  // One active row per (source_system, source_id) — mirrors idx_raw_st_*_unique
  await knex.raw(`
    CREATE UNIQUE INDEX idx_raw_st_calls_latest
      ON raw_st_calls (source_system, source_id)
      WHERE is_latest = true
  `);

  // History uniqueness — prevents duplicate ingestion of the same call at the same instant
  await knex.raw(`
    CREATE UNIQUE INDEX idx_raw_st_calls_history
      ON raw_st_calls (source_system, source_id, ingested_at)
  `);

  // Query-layer indexes for the most common filter patterns
  await knex.raw(`CREATE INDEX idx_raw_st_calls_direction ON raw_st_calls (direction) WHERE direction IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_raw_st_calls_call_type ON raw_st_calls (call_type) WHERE call_type IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_raw_st_calls_created_on ON raw_st_calls (created_on) WHERE created_on IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_raw_st_calls_customer ON raw_st_calls (st_customer_id) WHERE st_customer_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_raw_st_calls_job ON raw_st_calls (st_job_id) WHERE st_job_id IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('raw_st_calls');
}
