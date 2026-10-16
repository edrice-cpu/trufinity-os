import type { Knex } from 'knex';

/**
 * Supports the R05 backfill keyset scan without indexing Gmail content.
 * CONCURRENTLY is required because this migration must not take a blocking
 * table write lock in the shared PostgreSQL database.
 */
export const config = { transaction: false };

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE INDEX CONCURRENTLY IF NOT EXISTS raw_gmail_messages_r05_keyset_idx
    ON raw_gmail_messages (mailbox_id, thread_id, ingested_at)
    INCLUDE (mailbox_address)
    WHERE is_latest = true AND thread_id <> ''
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('DROP INDEX CONCURRENTLY IF EXISTS raw_gmail_messages_r05_keyset_idx');
}
