import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table.text('resolution_note').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table.dropColumn('resolution_note');
  });
}
