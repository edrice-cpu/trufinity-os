import type { Knex } from "knex";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('identity_mappings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('source_system').notNullable(); // 'ServiceTitan' or 'QuickBooks'
    table.string('entity_type').notNullable();   // 'Customer', 'Invoice', 'Payment'
    table.string('source_id').notNullable();     // The ID from the source system
    table.uuid('unified_entity_id').nullable();  // Will be populated once unified table is created and mapped
    
    // Identity resolution tracking
    table.string('confidence_level').notNullable().defaultTo('UNRESOLVED'); // 'VERIFIED', 'PROPOSED', 'UNRESOLVED'
    table.string('matching_method').nullable(); // e.g. 'EXACT_NAME', 'MANUAL', 'EXTERNAL_ID'
    table.string('status').notNullable().defaultTo('ACTIVE'); // 'ACTIVE', 'MERGED', 'DELETED'
    table.string('matched_by').nullable(); // system/user who made the match
    table.text('notes').nullable(); // Audit notes

    table.timestamp('created_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('modified_on', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['source_system', 'entity_type', 'source_id']);
    table.index(['unified_entity_id']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('identity_mappings');
}
