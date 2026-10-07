import type { Knex } from 'knex';

const serviceTitanRawTables = [
  'raw_st_locations',
  'raw_st_jobs',
  'raw_st_appointments',
  'raw_st_leads',
  'raw_st_bookings',
  'raw_st_invoices',
  'raw_st_payments',
  'raw_st_technicians',
];

export async function up(knex: Knex): Promise<void> {
  for (const tableName of serviceTitanRawTables) {
    await knex.schema.alterTable(tableName, (table) => {
      table.dropUnique(['source_id', 'ingested_at']);
    });
  }
}

export async function down(knex: Knex): Promise<void> {
  for (const tableName of serviceTitanRawTables) {
    await knex.schema.alterTable(tableName, (table) => {
      table.unique(['source_id', 'ingested_at']);
    });
  }
}
