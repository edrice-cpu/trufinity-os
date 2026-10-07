import type { Knex } from 'knex';

// The Detect layer: deterministic SQL rules over canonical data, zero AI
// (SPEC-BI-001 Section 4.1). One row per rule finding. Kept source-agnostic
// (not under src/modules/lace) since future rules may read other canonical
// tables (ServiceTitan/QBO) too.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('detected_alerts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('rule_code').notNullable(); // 'D-01', 'D-06', ...
    // Free-text dimension the finding applies to, e.g. an objection category
    // for D-06; null for tenant-wide rules like D-01.
    table.string('dimension').nullable();

    table.timestamp('period_start', { useTz: true }).notNullable();
    table.timestamp('period_end', { useTz: true }).notNullable();
    table.timestamp('baseline_start', { useTz: true }).nullable();
    table.timestamp('baseline_end', { useTz: true }).nullable();

    table.decimal('metric_value', 12, 4).notNullable();
    table.decimal('baseline_value', 12, 4).nullable();

    // Rule-specific supporting numbers (counts, sample sizes) for the Narrate
    // layer to describe without recomputing anything itself.
    table.jsonb('details').notNullable().defaultTo('{}');

    table.timestamp('detected_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['rule_code', 'period_start']);
    // One finding per rule+dimension+period per detection run (re-running the
    // same window replaces the prior finding instead of duplicating it).
    table.unique(['rule_code', 'dimension', 'period_start']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('detected_alerts');
}
