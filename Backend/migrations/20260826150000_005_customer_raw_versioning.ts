import type { Knex } from 'knex';

/**
 * Raw row identity is the generated UUID. Timestamps describe ingestion time
 * and must not be used as a version key: concurrent inserts can legitimately
 * share the same timestamp.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('raw_st_customers', (table) => {
    table.dropUnique(['source_id', 'ingested_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('raw_st_customers', (table) => {
    table.unique(['source_id', 'ingested_at']);
  });
}
