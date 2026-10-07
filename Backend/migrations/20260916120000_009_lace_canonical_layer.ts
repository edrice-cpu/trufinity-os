import type { Knex } from 'knex';

// Canonical layer for Lace AI Call Analysis, kept separate from the
// ServiceTitan/QBO canonical_* tables (canonical_jobs, canonical_bookings, etc.)
// because Lace records are call-level events, not the same business entities -
// there is no reliable unified_customer_id to join through yet. Feeds rules
// D-01 (booking rate decline) and D-06 (objection category spike) per SPEC-BI-001.
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('canonical_lace_calls', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Natural key: same as raw_lace_call_analysis.source_id (the id embedded
    // in the "Call link" URL - see call-analysis.ingestion.ts for why).
    table.string('lace_call_id').notNullable().unique();

    table.string('crm').nullable();
    table.string('csr').nullable();
    table.string('company').nullable();
    table.string('campaign').nullable();
    table.string('call_link').notNullable();
    table.string('job_number').nullable();
    table.string('crm_call_id').nullable();
    table.string('crm_tenant_id').nullable();
    table.string('customer_name').nullable();
    table.string('customer_phone').nullable();
    table.string('call_direction').nullable();

    table.boolean('booked').nullable();
    table.boolean('qualified').nullable();
    table.boolean('existing_customer').nullable();

    table.integer('duration_sec').nullable();
    table.integer('playbook_score').nullable();
    table.specificType('objections', 'text[]').nullable();

    table.string('unbooked_reason').nullable();
    table.text('cancellation_reason').nullable();
    table.text('short_summary').nullable();
    table.text('qualification_details').nullable();

    // "Date received (UTC)" + "Time received (UTC)" combined - what rules query against.
    table.timestamp('received_at', { useTz: true }).nullable();

    // Full raw row, for traceability back to exactly what the vendor sent.
    table.jsonb('source_specific_data').nullable();

    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['received_at']);
    table.index(['booked']);
    table.index(['csr']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('canonical_lace_calls');
}
