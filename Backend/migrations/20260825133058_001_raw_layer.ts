import type { Knex } from "knex";

const tables = [
  'raw_st_customers',
  'raw_st_locations',
  'raw_st_jobs',
  'raw_st_appointments',
  'raw_st_leads',
  'raw_st_bookings',
  'raw_st_invoices',
  'raw_st_payments',
  'raw_st_technicians',
  'raw_qbo_companyinfo',
  'raw_qbo_customers',
  'raw_qbo_invoices',
  'raw_qbo_payments',
  'raw_qbo_accounts'
];

export async function up(knex: Knex): Promise<void> {
  // Sync Tracking Infrastructure
  await knex.schema.createTable('sync_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source_system').notNullable(); 
    table.string('entity_type').notNullable();
    table.string('status').notNullable(); 
    table.timestamp('started_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.integer('records_processed').defaultTo(0);
    table.text('error_message').nullable();
  });

  await knex.schema.createTable('sync_errors', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('sync_run_id').notNullable().references('id').inTable('sync_runs').onDelete('CASCADE');
    table.string('source_id').nullable();
    table.text('error_message').notNullable();
    table.jsonb('payload').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.schema.createTable('raw_sync_metadata', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source_system').notNullable();
    table.string('entity_type').notNullable();
    table.string('continuation_token').nullable();
    table.timestamp('last_synced_at', { useTz: true }).nullable();
    table.unique(['source_system', 'entity_type']);
  });

  // Raw Entities
  for (const tableName of tables) {
    await knex.schema.createTable(tableName, (table) => {
      table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
      table.string('source_id').notNullable();
      table.jsonb('payload').notNullable();
      table.boolean('is_latest').notNullable().defaultTo(true);
      table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
      table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
      
      table.index(['source_id']);
      // Enforce append-only history constraint
      table.unique(['source_id', 'ingested_at']);
    });

    // Enforce is_latest = true uniqueness for active records
    await knex.schema.raw(
      `CREATE UNIQUE INDEX idx_${tableName}_unique ON ${tableName}(source_id) WHERE is_latest = true;`
    );
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const tableName of [...tables].reverse()) {
    await knex.schema.dropTableIfExists(tableName);
  }
  await knex.schema.dropTableIfExists('raw_sync_metadata');
  await knex.schema.dropTableIfExists('sync_errors');
  await knex.schema.dropTableIfExists('sync_runs');
}
