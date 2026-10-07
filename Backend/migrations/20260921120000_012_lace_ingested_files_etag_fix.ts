import type { Knex } from 'knex';

// Bug fix: the original unique constraint on lace_ingested_files was
// (export_type, s3_key) only - it did not include s3_etag. In production,
// when Lace re-sends a corrected export under the same S3 key with a new
// ETag (the exact "vendor re-sent a corrected export" scenario the
// ingestion code is designed to handle), the second commitFile() insert
// violated this constraint and the whole file's ingestion failed with a
// database error instead of superseding the prior version. The natural key
// for "have we ingested this exact file version" is (export_type, s3_key,
// s3_etag), matching isFileIngested()'s own lookup.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('lace_ingested_files', (table) => {
    table.dropUnique(['export_type', 's3_key']);
    table.unique(['export_type', 's3_key', 's3_etag']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('lace_ingested_files', (table) => {
    table.dropUnique(['export_type', 's3_key', 's3_etag']);
    table.unique(['export_type', 's3_key']);
  });
}
