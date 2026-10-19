import type { Knex } from 'knex';

// Widens raw_sync_metadata.continuation_token from VARCHAR(255) to TEXT.
//
// Motivation: ServiceTitan Telecom export continueFrom tokens are opaque strings
// whose length is undocumented. The existing VARCHAR(255) limit is safe for all
// current entity types (Customer, Job, etc.) whose tokens are short numeric
// cursors, but is an unacceptable risk for Telecom tokens which may be longer.
//
// This migration is intentionally additive and does not touch any other column or
// table. All existing token values are preserved verbatim.
//
// Ordering: must be applied before or concurrently with migration 020
// (raw_st_calls), since Telecom ingestion writes continuation tokens immediately
// after the first batch commit. In practice the migrations are applied in
// filename-timestamp order, placing 021 after 020, which is safe — Telecom
// ingestion is disabled by default and will not run until explicitly scheduled.
//
// PostgreSQL ALTER COLUMN … TYPE TEXT is a metadata-only operation on VARCHAR
// columns and does not require a full table rewrite or exclusive lock beyond the
// brief ALTER TABLE lock. Safe on a live database.
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    ALTER TABLE raw_sync_metadata
      ALTER COLUMN continuation_token TYPE TEXT
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Narrowing back to VARCHAR(255) will fail if any existing token exceeds 255
  // characters. The down migration truncates no data — PostgreSQL will error if
  // a value exceeds the new limit, surfacing the problem rather than silently
  // corrupting it.
  await knex.raw(`
    ALTER TABLE raw_sync_metadata
      ALTER COLUMN continuation_token TYPE VARCHAR(255)
  `);
}
