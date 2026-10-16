import type { Knex } from 'knex';

/**
 * Adds 'emergency' to the allowed classification labels on email_classification_results.
 *
 * DEPLOY ORDER:
 *   1. Run this migration.
 *   2. Deploy application code with the updated system prompt (v2) and 'emergency' label.
 *   3. Set GMAIL_CLASSIFIER_PROMPT_VERSION=v2 in .env.
 *   4. Set GOOGLE_R01_EMERGENCY_CLASSIFICATION_ENABLED=true in .env.
 *
 * BACKFILL REQUIREMENT:
 *   Messages classified with prompt_version='v1' were never evaluated for the
 *   'emergency' label and may include genuine emergencies. Run a controlled
 *   reclassification of historical inbound messages with the v2 prompt to
 *   ensure retroactive emergency detection is complete before relying on it.
 *
 * ROLLBACK NOTE:
 *   The down() migration removes 'emergency' from the check constraint. Any
 *   rows with classification_label='emergency' must be deleted or updated
 *   before rolling back, or the constraint add in down() will fail.
 */

const TABLE = 'email_classification_results';
const CONSTRAINT = `${TABLE}_classification_label_check`;

const OLD_LABELS = `'complaint', 'billing_dispute', 'cancellation_intent', 'legal_or_regulatory_threat', 'damage_claim', 'escalation_request', 'none'`;
const NEW_LABELS = `'complaint', 'billing_dispute', 'cancellation_intent', 'legal_or_regulatory_threat', 'damage_claim', 'escalation_request', 'emergency', 'none'`;

export async function up(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (classification_label IN (${NEW_LABELS}))`);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`ALTER TABLE ${TABLE} DROP CONSTRAINT IF EXISTS ${CONSTRAINT}`);
  await knex.raw(`ALTER TABLE ${TABLE} ADD CONSTRAINT ${CONSTRAINT} CHECK (classification_label IN (${OLD_LABELS}))`);
}
