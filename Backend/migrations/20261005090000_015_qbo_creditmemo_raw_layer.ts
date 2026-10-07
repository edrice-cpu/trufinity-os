import type { Knex } from 'knex';

// Raw layer for QuickBooks CreditMemo - needed for F-04d (AR: credit memo
// detection). Not part of the original raw-layer migration's entity list, so
// it's added here following the same append-only shape every raw_qbo_*/
// raw_st_* table already uses (see migrations/001_raw_layer.ts).
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('raw_qbo_creditmemos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source_id').notNullable();
    table.jsonb('payload').notNullable();
    table.boolean('is_latest').notNullable().defaultTo(true);
    table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');

    table.index(['source_id']);
    table.unique(['source_id', 'ingested_at']);
  });

  await knex.schema.raw(
    'CREATE UNIQUE INDEX idx_raw_qbo_creditmemos_unique ON raw_qbo_creditmemos(source_id) WHERE is_latest = true;',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('raw_qbo_creditmemos');
}
