import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('email', 320).notNullable();
    table.string('normalized_email', 320).notNullable();
    table.string('full_name', 200).nullable();
    table.text('password_hash').notNullable();
    table.boolean('is_active').notNullable().defaultTo(true);
    table.integer('failed_login_attempts').notNullable().defaultTo(0);
    table.timestamp('locked_until', { useTz: true }).nullable();
    table.timestamp('last_login_at', { useTz: true }).nullable();
    table.timestamp('password_changed_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['normalized_email']);
    table.check('normalized_email = lower(normalized_email)');
    table.check('failed_login_attempts >= 0');
  });

  // Only SHA-256 hashes of session and reset tokens are stored; raw tokens never touch the database.
  await knex.schema.createTable('user_sessions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('token_hash', 64).notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('revoked_at', { useTz: true }).nullable();
    table.string('ip_address', 64).nullable();
    table.string('user_agent', 512).nullable();
    table.timestamp('last_seen_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['token_hash']);
    table.index(['user_id', 'revoked_at']);
    table.index(['expires_at']);
  });

  await knex.schema.createTable('password_reset_tokens', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE');
    table.string('token_hash', 64).notNullable();
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('used_at', { useTz: true }).nullable();
    table.string('requested_ip', 64).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['token_hash']);
    table.index(['user_id', 'created_at']);
    table.index(['expires_at']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('password_reset_tokens');
  await knex.schema.dropTableIfExists('user_sessions');
  await knex.schema.dropTableIfExists('users');
}
