import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  // 1. unified_invoices
  await knex.schema.createTable('unified_invoices', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').notNullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    table.uuid('canonical_job_id').nullable().references('id').inTable('canonical_jobs').onDelete('RESTRICT');
    table.uuid('created_by_tech_id').nullable().references('id').inTable('canonical_technicians').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('status').nullable();
    
    // Financials
    table.decimal('total_amount', 15, 2).notNullable().defaultTo(0);
    table.decimal('balance', 15, 2).notNullable().defaultTo(0);
    table.decimal('tax', 15, 2).notNullable().defaultTo(0);
    table.decimal('discount', 15, 2).notNullable().defaultTo(0);
    
    // Dates
    table.date('invoice_date').nullable();
    table.date('due_date').nullable();
    
    table.jsonb('source_specific_data').nullable();
    table.timestamp('created_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('modified_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    
    table.index(['unified_customer_id']);
    table.index(['canonical_job_id']);
    table.index(['created_by_tech_id']);
    table.index(['invoice_date']);
    table.index(['due_date']);
  });

  // 2. unified_payments
  await knex.schema.createTable('unified_payments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('unified_customer_id').notNullable().references('id').inTable('unified_customers').onDelete('RESTRICT');
    table.uuid('applied_by_tech_id').nullable().references('id').inTable('canonical_technicians').onDelete('RESTRICT');
    
    // Normalized business columns
    table.string('status').nullable();
    table.string('type').nullable();
    
    // Financials
    table.decimal('total_amount', 15, 2).notNullable().defaultTo(0);
    table.decimal('unapplied_amount', 15, 2).notNullable().defaultTo(0);
    
    // Dates
    table.date('payment_date').nullable();
    
    table.jsonb('source_specific_data').nullable();
    table.timestamp('created_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('modified_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    
    table.index(['unified_customer_id']);
    table.index(['applied_by_tech_id']);
    table.index(['payment_date']);
  });

  // 3. unified_payment_applications (Junction)
  await knex.schema.createTable('unified_payment_applications', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('payment_id').notNullable().references('id').inTable('unified_payments').onDelete('RESTRICT');
    table.uuid('invoice_id').notNullable().references('id').inTable('unified_invoices').onDelete('RESTRICT');
    table.decimal('applied_amount', 15, 2).notNullable().defaultTo(0);
    table.timestamp('applied_on', { useTz: true }).nullable();
    
    table.unique(['payment_id', 'invoice_id']);
    table.index(['payment_id']);
    table.index(['invoice_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('unified_payment_applications');
  await knex.schema.dropTableIfExists('unified_payments');
  await knex.schema.dropTableIfExists('unified_invoices');
}
