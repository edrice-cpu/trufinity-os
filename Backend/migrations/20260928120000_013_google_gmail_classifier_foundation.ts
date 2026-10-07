import type { Knex } from 'knex';

const labels = "'complaint', 'billing_dispute', 'cancellation_intent', 'legal_or_regulatory_threat', 'damage_claim', 'escalation_request', 'none'";

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_classification_results', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('mailbox_id').nullable().references('id').inTable('google_gmail_mailboxes').onDelete('SET NULL');
    table.string('mailbox_address').notNullable();
    table.string('provider_message_id').notNullable();
    table.string('thread_id').nullable();
    table.string('source_reference').nullable();
    table.string('classification_label').notNullable();
    table.decimal('confidence', 10, 8).notNullable();
    table.string('reason', 280).notNullable();
    table.string('decision_status').notNullable();
    table.string('model_provider').notNullable();
    table.string('model_name').notNullable();
    table.string('prompt_version').notNullable();
    table.timestamp('classified_at', { useTz: true }).notNullable();
    table.string('idempotency_key').notNullable().unique();
    table.uuid('supersedes_id').nullable().references('id').inTable('email_classification_results').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.check(`classification_label IN (${labels})`);
    table.check("confidence >= 0 AND confidence <= 1");
    table.check("decision_status IN ('ESCALATION', 'REVIEW_REQUIRED', 'NONE')");
    table.check("btrim(reason) <> '' AND reason NOT LIKE '%' || chr(10) || '%' AND reason NOT LIKE '%' || chr(13) || '%'");
    table.index(['mailbox_id', 'provider_message_id', 'classified_at']);
    table.index(['decision_status', 'created_at']);
  });

  await knex.schema.createTable('email_escalation_work_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('classification_result_id').notNullable().unique().references('id').inTable('email_classification_results').onDelete('RESTRICT');
    table.uuid('mailbox_id').nullable().references('id').inTable('google_gmail_mailboxes').onDelete('SET NULL');
    table.string('provider_message_id').notNullable();
    table.string('work_type').notNullable();
    table.string('workflow_status').notNullable().defaultTo('OPEN');
    table.string('routed_owner_reference').nullable();
    table.timestamp('acknowledgement_deadline', { useTz: true }).nullable();
    table.timestamp('resolution_deadline', { useTz: true }).nullable();
    table.timestamp('acknowledged_at', { useTz: true }).nullable();
    table.timestamp('resolved_at', { useTz: true }).nullable();
    table.string('sla_state').notNullable().defaultTo('UNCONFIGURED');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.check("work_type IN ('ESCALATION', 'REVIEW_REQUIRED')");
    table.check("workflow_status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED')");
    table.check("sla_state IN ('UNCONFIGURED', 'ON_TRACK', 'AT_RISK', 'BREACHED', 'MET')");
    table.index(['workflow_status', 'created_at']);
    table.index(['sla_state', 'acknowledgement_deadline']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_escalation_work_items');
  await knex.schema.dropTableIfExists('email_classification_results');
}
