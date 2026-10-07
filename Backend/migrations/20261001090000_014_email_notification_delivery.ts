import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('email_notification_deliveries', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('work_item_id').notNullable()
      .references('id').inTable('email_escalation_work_items').onDelete('RESTRICT');
    table.string('notification_type').notNullable().defaultTo('WORK_ITEM');
    table.string('channel').notNullable().defaultTo('SMTP');
    table.string('recipient').notNullable();
    table.string('status').notNullable().defaultTo('PENDING');
    table.integer('attempt_count').notNullable().defaultTo(0);
    table.timestamp('last_attempted_at', { useTz: true }).nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.string('last_error_category').nullable();
    table.string('idempotency_key').notNullable().unique();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.check("notification_type = 'WORK_ITEM'");
    table.check("channel = 'SMTP'");
    table.check("status IN ('PENDING', 'SENDING', 'FAILED', 'SENT')");
    table.check('attempt_count >= 0');
    table.index(['status', 'last_attempted_at']);
    table.index(['work_item_id', 'status']);
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('email_notification_deliveries');
}
