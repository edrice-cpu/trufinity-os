import type { Knex } from 'knex';

const qboRawTables = ['raw_qbo_customers', 'raw_qbo_accounts', 'raw_qbo_invoices', 'raw_qbo_payments'];

export async function up(knex: Knex): Promise<void> {
  for (const tableName of qboRawTables) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropUnique(['source_id', 'ingested_at']);
      table.boolean('is_deleted').notNullable().defaultTo(false);
    });
  }

  await knex.schema.createTable('qbo_cdc_checkpoints', (table) => {
    table.string('entity_type').primary();
    table.timestamp('checkpoint_at', { useTz: true }).notNullable();
    table.timestamp('last_request_since', { useTz: true }).notNullable();
    table.timestamp('provider_time', { useTz: true }).notNullable();
    table.integer('records_processed').notNullable().defaultTo(0);
    table.uuid('last_sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('qbo_cdc_checkpoint_history', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('entity_type').notNullable();
    table.timestamp('checkpoint_at', { useTz: true }).notNullable();
    table.timestamp('last_request_since', { useTz: true }).notNullable();
    table.timestamp('provider_time', { useTz: true }).notNullable();
    table.integer('records_processed').notNullable();
    table.uuid('sync_run_id').notNullable().references('id').inTable('sync_runs').onDelete('CASCADE');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['entity_type', 'sync_run_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('qbo_cdc_checkpoint_history');
  await knex.schema.dropTableIfExists('qbo_cdc_checkpoints');
  for (const tableName of qboRawTables) {
    await knex.schema.alterTable(tableName, (table) => {
      table.unique(['source_id', 'ingested_at']);
      table.dropColumn('is_deleted');
    });
  }
}
