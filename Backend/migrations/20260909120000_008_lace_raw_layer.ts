import type { Knex } from 'knex';

const rawTables = ['raw_lace_call_analysis', 'raw_lace_agent_performance'];

export async function up(knex: Knex): Promise<void> {
  for (const tableName of rawTables) {
    await knex.schema.createTable(tableName, (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('source_id').notNullable();
      table.jsonb('payload').notNullable();
      table.boolean('is_latest').notNullable().defaultTo(true);
      table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');

      table.index(['source_id']);
    });

    // Enforce is_latest = true uniqueness for active records (mirrors raw_st_*/raw_qbo_* tables)
    await knex.schema.raw(
      `CREATE UNIQUE INDEX idx_${tableName}_unique ON ${tableName}(source_id) WHERE is_latest = true;`,
    );
  }

  // Lace delivers discrete files (S3 export), not a paginated/continuation API, so
  // idempotency is tracked per-file rather than via raw_sync_metadata's continuation token.
  await knex.schema.createTable('lace_ingested_files', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('export_type').notNullable(); // 'call_analysis' | 'agent_performance'
    table.string('s3_key').notNullable();
    table.string('s3_etag').notNullable();
    table.integer('row_count').notNullable().defaultTo(0);
    table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
    table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['export_type', 's3_key']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('lace_ingested_files');
  for (const tableName of [...rawTables].reverse()) {
    await knex.schema.dropTableIfExists(tableName);
  }
}
