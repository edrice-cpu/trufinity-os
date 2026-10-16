import type { Knex } from 'knex';

/**
 * Phase 1 R05 derived metadata. These tables contain no Gmail body, snippet,
 * subject, HTML, or attachment content. R05 reporting remains on its existing
 * implementation until the Phase 2 query cutover is approved.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('google_gmail_message_facts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('mailbox_id').notNullable().references('id').inTable('google_gmail_mailboxes').onDelete('CASCADE');
    table.text('mailbox_address').notNullable();
    table.text('thread_id').notNullable();
    table.text('provider_message_id').notNullable();
    table.timestamp('internal_date', { useTz: true }).notNullable();
    table.text('direction').notNullable()
      .checkIn(['INBOUND', 'OUTBOUND', 'UNKNOWN'], 'google_gmail_message_facts_direction_check');
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['mailbox_id', 'provider_message_id'], {
      indexName: 'google_gmail_message_facts_message_key',
    });
    table.index(
      ['mailbox_id', 'thread_id', 'internal_date', 'provider_message_id'],
      'google_gmail_message_facts_thread_time_idx',
    );
  });

  await knex.schema.createTable('google_gmail_thread_responsiveness', (table) => {
    table.uuid('mailbox_id').notNullable().references('id').inTable('google_gmail_mailboxes').onDelete('CASCADE');
    table.text('mailbox_address').notNullable();
    table.text('thread_id').notNullable();
    table.timestamp('last_activity_at', { useTz: true }).nullable();
    table.text('last_outbound_message_id').nullable();
    table.timestamp('last_outbound_at', { useTz: true }).nullable();
    table.text('oldest_unanswered_message_id').nullable();
    table.timestamp('oldest_unanswered_at', { useTz: true }).nullable();
    table.integer('classified_message_count').notNullable().defaultTo(0);
    table.integer('message_count').notNullable().defaultTo(0);
    table.boolean('has_unanswered').notNullable().defaultTo(false);
    table.integer('state_version').notNullable().defaultTo(1);
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.primary(['mailbox_id', 'thread_id']);
    table.index(
      ['mailbox_id', 'has_unanswered', 'oldest_unanswered_at'],
      'google_gmail_thread_resp_unanswered_idx',
    );
    table.index(
      ['mailbox_id', 'last_activity_at'],
      'google_gmail_thread_resp_activity_idx',
    );
  });

  await knex.schema.createTable('google_gmail_thread_state_backfill', (table) => {
    table.text('job_name').primary();
    table.uuid('cursor_mailbox_id').nullable();
    table.text('cursor_thread_id').nullable();
    table.timestamp('scan_started_at', { useTz: true }).notNullable();
    table.text('status').notNullable().defaultTo('RUNNING')
      .checkIn(['RUNNING', 'PAUSED', 'COMPLETED'], 'google_gmail_thread_backfill_status_check');
    table.bigInteger('batches_processed').notNullable().defaultTo(0);
    table.bigInteger('threads_processed').notNullable().defaultTo(0);
    table.bigInteger('threads_skipped_concurrent').notNullable().defaultTo(0);
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('google_gmail_thread_responsiveness');
  await knex.schema.dropTableIfExists('google_gmail_message_facts');
  await knex.schema.dropTableIfExists('google_gmail_thread_state_backfill');
}
