import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. unified_customers
  await knex.schema.createTable('unified_customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Removed st_customer_id and qbo_customer_id as they belong in identity_mappings
    table.string('name').nullable(); // Basic unified metadata
    table.jsonb('source_specific_data').nullable();
    table.timestamp('created_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('modified_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // 2. canonical_technicians
  await knex.schema.createTable('canonical_technicians', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').notNullable();
    table.string('login_name').notNullable();
    table.boolean('active').notNullable().defaultTo(true);
    table.jsonb('source_specific_data').nullable();
    
    table.index(['login_name']);
  });

  // 3. canonical_locations
  await knex.schema.createTable('canonical_locations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').notNullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('name').nullable();
    table.string('street').nullable();
    table.string('city').nullable();
    table.string('state').nullable();
    table.string('zip').nullable();
    table.string('country').nullable();
    
    table.jsonb('source_specific_data').nullable();
    
    table.index(['unified_customer_id']);
  });

  // 4. canonical_jobs
  await knex.schema.createTable('canonical_jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').notNullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    table.uuid('canonical_location_id').notNullable().references('id').inTable('canonical_locations').onDelete('RESTRICT');
    table.uuid('sold_by_tech_id').nullable().references('id').inTable('canonical_technicians').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('job_number').nullable();
    table.string('type').nullable();
    table.string('status').nullable();
    
    table.jsonb('source_specific_data').nullable();
    
    table.index(['unified_customer_id']);
    table.index(['canonical_location_id']);
    table.index(['sold_by_tech_id']);
  });

  // 5. canonical_appointments
  await knex.schema.createTable('canonical_appointments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('canonical_job_id').notNullable().references('id').inTable('canonical_jobs').onDelete('RESTRICT');
    table.uuid('assigned_tech_id').nullable().references('id').inTable('canonical_technicians').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('status').nullable();
    table.timestamp('start_time', { useTz: true }).nullable();
    table.timestamp('end_time', { useTz: true }).nullable();
    
    table.jsonb('source_specific_data').nullable();
    
    table.index(['canonical_job_id']);
    table.index(['assigned_tech_id']);
  });

  // 6. canonical_leads
  await knex.schema.createTable('canonical_leads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').nullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    table.uuid('canonical_location_id').nullable().references('id').inTable('canonical_locations').onDelete('RESTRICT');
    table.string('status').nullable();
    table.jsonb('source_specific_data').nullable();
    
    table.index(['unified_customer_id']);
    table.index(['canonical_location_id']);
  });

  // 7. canonical_bookings
  await knex.schema.createTable('canonical_bookings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').nullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    table.uuid('canonical_location_id').nullable().references('id').inTable('canonical_locations').onDelete('RESTRICT');
    table.uuid('canonical_job_id').nullable().references('id').inTable('canonical_jobs').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('status').nullable();
    table.string('name').nullable();
    
    table.jsonb('source_specific_data').nullable();
    
    table.index(['unified_customer_id']);
    table.index(['canonical_location_id']);
    table.index(['canonical_job_id']);
  });

  // 8. canonical_qbo_accounts
  await knex.schema.createTable('canonical_qbo_accounts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('name').nullable();
    table.string('account_type').nullable();
    table.jsonb('source_specific_data').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('canonical_qbo_accounts');
  await knex.schema.dropTableIfExists('canonical_bookings');
  await knex.schema.dropTableIfExists('canonical_leads');
  await knex.schema.dropTableIfExists('canonical_appointments');
  await knex.schema.dropTableIfExists('canonical_jobs');
  await knex.schema.dropTableIfExists('canonical_locations');
  await knex.schema.dropTableIfExists('canonical_technicians');
  await knex.schema.dropTableIfExists('unified_customers');
}
