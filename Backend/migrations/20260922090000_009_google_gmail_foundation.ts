import type { Knex } from 'knex';

const approvedContentMailboxes = "'service@trufinity.ca', 'support@trufinity.ca', 'billing@trufinity.ca'";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_gmail_mailboxes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.string('mailbox_address').notNullable();
    table.string('normalized_mailbox_address').notNullable();
    table.string('account_type').notNullable().defaultTo('USER');
    table.boolean('enabled').notNullable().defaultTo(true);
    table.string('content_mode').notNullable().defaultTo('METADATA');
    table.jsonb('provider_metadata').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.unique(['normalized_mailbox_address']);
    table.index(['enabled', 'content_mode']);
    table.check(`content_mode IN ('METADATA', 'CONTENT')`);
    table.check(`content_mode = 'METADATA' OR normalized_mailbox_address IN (${approvedContentMailboxes})`);
  });

  await knex.schema.createTable('raw_gmail_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('mailbox_id').notNullable().references('id').inTable('google_gmail_mailboxes').onDelete('RESTRICT');
    table.string('mailbox_address').notNullable();
    table.string('provider_message_id').notNullable();
    table.string('thread_id').notNullable();
    table.jsonb('payload').notNullable();
    table.string('content_mode').notNullable();
    table.timestamp('internal_date', { useTz: true }).nullable();
    table.string('provider_history_id').nullable();
    table.boolean('is_deleted').notNullable().defaultTo(false);
    table.boolean('is_latest').notNullable().defaultTo(true);
    table.timestamp('ingested_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.uuid('sync_run_id').nullable().references('id').inTable('sync_runs').onDelete('SET NULL');
    table.index(['mailbox_id', 'provider_message_id']);
    table.index(['mailbox_id', 'thread_id']);
    table.index(['mailbox_id', 'internal_date']);
    table.index(['mailbox_id', 'provider_history_id']);
    table.check(`content_mode IN ('METADATA', 'CONTENT')`);
    table.check(`content_mode = 'METADATA' OR mailbox_address IN (${approvedContentMailboxes})`);
  });
  await knex.schema.raw(
    'CREATE UNIQUE INDEX idx_raw_gmail_messages_latest ON raw_gmail_messages(mailbox_id, provider_message_id) WHERE is_latest = true',
  );

  await knex.schema.createTable('raw_gmail_sync_metadata', (table) => {
    table.uuid('mailbox_id').primary().references('id').inTable('google_gmail_mailboxes').onDelete('CASCADE');
    table.string('historical_page_token').nullable();
    table.string('history_id').nullable();
    table.string('last_successful_history_id').nullable();
    table.timestamp('last_successful_sync_at', { useTz: true }).nullable();
    table.jsonb('state').nullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('raw_gmail_sync_metadata');
  await knex.schema.dropTableIfExists('raw_gmail_messages');
  await knex.schema.dropTableIfExists('google_gmail_mailboxes');
}
