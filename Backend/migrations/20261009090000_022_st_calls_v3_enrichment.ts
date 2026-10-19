import type { Knex } from 'knex';

// Creates st_calls_v3_enrichment — stores supplementary fields from the
// ServiceTitan Telecom V3 Calls API that are NOT available in the V2 Export.
//
// Source: GET /telecom/v3/tenant/{tenant}/calls
// Verified live: HTTP 200, offset-based pagination (page/pageSize/hasMore),
//   leadCall.id matches raw_st_calls.source_id for in-window records.
//
// Design rationale:
//   - A separate table keeps raw_st_calls as a pure V2 Export store.
//     V3 and V2 are separate API contracts with independent pagination,
//     update cycles, and schema evolution paths.
//   - Join key: (source_system, source_id) — mirrors raw_st_calls uniqueness.
//   - No FK constraint to raw_st_calls — the raw layer never has FK constraints
//     between tables. V3 records for calls not yet in the export are stored with
//     v2_linked = false and linked retroactively when V2 ingestion catches up.
//   - call_received_on filled here from leadCall.receivedOn — this was
//     intentionally omitted from raw_st_calls pending confirmation of the correct
//     source field (see migration 020 comment). V3 probe confirmed it.
//
// Privacy notes:
//   - v3_payload stores the full V3 Bundle/leadCall response verbatim.
//     It contains from/to phone numbers — handled identically to raw_st_calls.
//   - agent_name is stored as a column for query access; also present in payload.
//   - No transcript or audio content is stored here.
//
// Synchronisation strategy:
//   - Historical: one full pass with createdOnOrAfter=HISTORICAL_FROM, page by page.
//   - Incremental: uses modifiedOnOrAfter against the last successful run time to
//     capture both new calls and modifications to older calls (e.g. agent reassign,
//     callType reclassification, tag updates). See telecom-calls-v3.ingestion.ts.
//   - Checkpoint stored in raw_sync_metadata under entityType = 'TelecomCallV3'.
//
// Idempotency:
//   - Upsert on (source_system, source_id) — conflict updates all non-key columns.
//   - v2_linked flag is set to true at upsert time when a matching raw_st_calls row
//     already exists; otherwise left false and reconciled asynchronously.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('st_calls_v3_enrichment', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));

    // Source identity — same scope as raw_st_calls (source_system includes tenant ID)
    table.string('source_system').notNullable();
    table.string('source_id').notNullable();      // = leadCall.id (numeric, stored as string)

    // Enrichment columns — V3 fields not available in V2 Export
    table.timestamp('call_received_on', { useTz: true }).nullable();  // leadCall.receivedOn
    table.string('call_type').nullable();                              // leadCall.callType (e.g. 'Lead')
    table.string('direction').nullable();                              // leadCall.direction
    table.string('duration').nullable();                               // leadCall.duration ISO string
    table.boolean('active').nullable();                                // leadCall.active
    table.string('sid').nullable();                                    // leadCall.sid (Twilio SID)
    table.string('reason').nullable();                                 // leadCall.reason (nullable)

    // Agent enrichment (V3 returns full agent object; V2 only has agent.id)
    table.string('agent_id').nullable();
    table.string('agent_name').nullable();

    // Campaign enrichment (id already in raw_st_calls; name only in V3)
    table.string('campaign_id').nullable();

    // Tags — stored as JSONB array; nullable when no tags are present
    table.jsonb('tags').nullable();               // leadCall.tags[]

    // V2 linkage flag — true once a raw_st_calls row with the same source_id exists
    table.boolean('v2_linked').notNullable().defaultTo(false);

    // Raw V3 payload — the full Bundle+leadCall JSON verbatim
    table.jsonb('v3_payload').notNullable();

    // Ingestion timestamps
    table.timestamp('v3_created_on', { useTz: true }).nullable();     // leadCall.createdOn
    table.timestamp('v3_modified_on', { useTz: true }).nullable();    // leadCall.modifiedOn
    table.timestamp('enriched_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('enrichment_updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
  });

  // One enrichment row per (source_system, source_id)
  await knex.raw(`
    CREATE UNIQUE INDEX idx_st_calls_v3_enrichment_call
      ON st_calls_v3_enrichment (source_system, source_id)
  `);

  // Time-based filters for incremental window queries
  await knex.raw(`
    CREATE INDEX idx_st_calls_v3_enrichment_received_on
      ON st_calls_v3_enrichment (call_received_on)
      WHERE call_received_on IS NOT NULL
  `);

  await knex.raw(`
    CREATE INDEX idx_st_calls_v3_enrichment_created_on
      ON st_calls_v3_enrichment (v3_created_on)
      WHERE v3_created_on IS NOT NULL
  `);

  // Fast lookup for v2_linked=false to drive reconciliation passes
  await knex.raw(`
    CREATE INDEX idx_st_calls_v3_enrichment_unlinked
      ON st_calls_v3_enrichment (source_system, source_id)
      WHERE v2_linked = false
  `);

  await knex.raw(`CREATE INDEX idx_st_calls_v3_enrichment_agent ON st_calls_v3_enrichment (agent_id) WHERE agent_id IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_st_calls_v3_enrichment_call_type ON st_calls_v3_enrichment (call_type) WHERE call_type IS NOT NULL`);
  await knex.raw(`CREATE INDEX idx_st_calls_v3_enrichment_sid ON st_calls_v3_enrichment (sid) WHERE sid IS NOT NULL`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('st_calls_v3_enrichment');
}
