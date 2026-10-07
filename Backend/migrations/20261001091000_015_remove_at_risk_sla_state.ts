import type { Knex } from 'knex';

const constraintName = 'email_escalation_work_items_sla_state_check';
const supportedStates = "'UNCONFIGURED', 'ON_TRACK', 'BREACHED', 'MET'";
const legacyStates = "'UNCONFIGURED', 'ON_TRACK', 'AT_RISK', 'BREACHED', 'MET'";

export async function up(knex: Knex): Promise<void> {
  const row = await knex('email_escalation_work_items')
    .where({ sla_state: 'AT_RISK' })
    .count<{ count: string }>({ count: '*' })
    .first();
  const atRiskCount = Number(row?.count ?? 0);
  if (atRiskCount > 0) {
    throw new Error('SLA constraint migration requires explicit handling of existing AT_RISK rows.');
  }

  await knex.raw(`ALTER TABLE email_escalation_work_items DROP CONSTRAINT IF EXISTS ${constraintName}`);
  await knex.raw(`ALTER TABLE email_escalation_work_items ADD CONSTRAINT ${constraintName} CHECK (sla_state IN (${supportedStates}))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE email_escalation_work_items DROP CONSTRAINT IF EXISTS ${constraintName}`);
  await knex.raw(`ALTER TABLE email_escalation_work_items ADD CONSTRAINT ${constraintName} CHECK (sla_state IN (${legacyStates}))`);
}
