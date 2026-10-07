import type { Knex } from 'knex';

// The Narrate layer writes prose describing a Detect-layer finding - it never
// computes or alters the numbers, only the two columns below (SPEC-BI-001
// Section 4.1). Kept on detected_alerts rather than a separate table since
// narration is a 1:1 enrichment of a finding, not its own entity.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('detected_alerts', (table) => {
    table.text('narrative').nullable();
    table.timestamp('narrated_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('detected_alerts', (table) => {
    table.dropColumn('narrative');
    table.dropColumn('narrated_at');
  });
}
