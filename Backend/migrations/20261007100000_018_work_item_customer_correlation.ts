import type { Knex } from 'knex';

// Adds customer correlation fields to email_escalation_work_items.
//
// Correlation strategy:
//   The Gmail From header is parsed to a normalized email address and matched
//   against unified_customers.source_specific_data->'quickbooks'->'PrimaryEmailAddr'->>'Address'.
//   A match is only stored when exactly one unified customer matches (zero or
//   multiple matches leave the fields null). No ServiceTitan customer ID is
//   stored because the identity_mappings table does not have a cross-system
//   ST ↔ unified_customers mapping.
//
// Job/invoice correlation is not supported: Layer A metadata mode intentionally
// does not persist message content, and no deterministic job/invoice identifier
// exists in the safe persisted metadata.
//
// Fields:
//   unified_customer_id    — FK to unified_customers (nullable, ON DELETE SET NULL)
//   customer_display_name  — denormalized display name at correlation time (nullable)
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table
      .uuid('unified_customer_id')
      .nullable()
      .references('id')
      .inTable('unified_customers')
      // SET NULL so customer merges/deletions do not block or cascade-delete work items.
      .onDelete('SET NULL');
    table.text('customer_display_name').nullable();
  });

  // Sparse functional index on the JSONB email path to make correlation lookups
  // efficient even with a large unified_customers table.
  await knex.raw(`
    CREATE INDEX email_escalation_work_items_customer_idx
      ON email_escalation_work_items (unified_customer_id)
      WHERE unified_customer_id IS NOT NULL
  `);

  // Case-insensitive functional index — expression must use lower() to match the
  // query predicate in work-item-correlation.service.ts exactly, so PostgreSQL's
  // planner recognises it as index-eligible.
  await knex.raw(`
    CREATE INDEX unified_customers_qbo_email_lower_idx
      ON unified_customers (
        lower(source_specific_data->'quickbooks'->'PrimaryEmailAddr'->>'Address')
      )
      WHERE source_specific_data->'quickbooks'->'PrimaryEmailAddr'->>'Address' IS NOT NULL
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX IF EXISTS unified_customers_qbo_email_lower_idx');
  await knex.raw('DROP INDEX IF EXISTS email_escalation_work_items_customer_idx');

  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table.dropColumn('customer_display_name');
    table.dropColumn('unified_customer_id');
  });
}
