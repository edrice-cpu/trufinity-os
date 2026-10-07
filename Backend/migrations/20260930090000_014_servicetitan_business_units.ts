import type { Knex } from 'knex';

// Business Units are a small, mostly-static ServiceTitan settings list, not a
// delta export. Needed to resolve businessUnitId (captured on jobs/leads/
// bookings) to a real department name for the dashboard Department filter
// (e.g. "Company" / "Service" / "New Construction").
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('raw_st_business_units', (table) => {
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
    'CREATE UNIQUE INDEX idx_raw_st_business_units_unique ON raw_st_business_units(source_id) WHERE is_latest = true;',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('raw_st_business_units');
}
