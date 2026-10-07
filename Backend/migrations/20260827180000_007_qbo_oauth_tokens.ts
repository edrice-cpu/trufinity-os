import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('qbo_oauth_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('realm_id').notNullable().unique();
    table.text('access_token').notNullable();
    table.text('refresh_token').notNullable();
    table.bigInteger('access_token_expiry').notNullable();
    table.bigInteger('refresh_token_expiry').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('qbo_oauth_tokens');
}
