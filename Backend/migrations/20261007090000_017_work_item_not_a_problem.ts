import type { Knex } from 'knex';

// Adds the NOT_A_PROBLEM terminal workflow status and its audit columns to
// email_escalation_work_items. This status records that an authenticated user
// reviewed a flagged item and determined it was not actionable. It is distinct
// from ACKNOWLEDGED (active handling in progress) and RESOLVED (item addressed).
//
// PostgreSQL does not support dropping a CHECK constraint by expression, only by
// name. The constraint was created without an explicit name in migration 013, so
// PostgreSQL auto-generated one (typically <table>_<column>_check). Rather than
// guessing or hard-coding the generated name, the down() migration recreates the
// original constraint by dropping and re-adding it via raw SQL.
export async function up(knex: Knex): Promise<void> {
  // 1. Drop the existing workflow_status check constraint so we can widen it.
  //    PostgreSQL names an unnamed check constraint <table>_<col>_check when
  //    there is only one; the actual suffix depends on the server. Use a raw
  //    ALTER TABLE that drops all check constraints whose definition matches.
  await knex.raw(`
    DO $$
    DECLARE
      cname TEXT;
    BEGIN
      SELECT conname
        INTO cname
        FROM pg_constraint
       WHERE conrelid = 'email_escalation_work_items'::regclass
         AND contype  = 'c'
         AND pg_get_constraintdef(oid) LIKE '%workflow_status%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE email_escalation_work_items DROP CONSTRAINT %I', cname);
      END IF;
    END
    $$;
  `);

  // 2. Add the widened constraint including NOT_A_PROBLEM.
  await knex.raw(`
    ALTER TABLE email_escalation_work_items
      ADD CONSTRAINT email_escalation_work_items_workflow_status_check
      CHECK (workflow_status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED', 'NOT_A_PROBLEM'))
  `);

  // 3. Add audit columns for the dismissal action.
  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table.timestamp('dismissed_at', { useTz: true }).nullable();
    // Stores the authenticated user's id at the time of dismissal (text to avoid
    // a hard FK dependency on the auth users table and to survive user deletion).
    table.text('dismissed_by_user_id').nullable();
    // Optional human-readable reason, bounded to prevent abuse.
    table.string('dismissal_reason', 500).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  // Guard: the narrowed constraint cannot be added while NOT_A_PROBLEM rows exist.
  // This mirrors the explicit guard pattern used in migration 015 for AT_RISK rows.
  const row = await knex('email_escalation_work_items')
    .where({ workflow_status: 'NOT_A_PROBLEM' })
    .count<{ count: string }>({ count: '*' })
    .first();
  const notAProblemCount = Number(row?.count ?? 0);
  if (notAProblemCount > 0) {
    throw new Error(
      `Cannot roll back migration 017: ${notAProblemCount} row(s) have workflow_status = 'NOT_A_PROBLEM'. ` +
      'Resolve or reassign those rows before rolling back.',
    );
  }

  // 1. Remove audit columns.
  await knex.schema.alterTable('email_escalation_work_items', (table) => {
    table.dropColumn('dismissed_at');
    table.dropColumn('dismissed_by_user_id');
    table.dropColumn('dismissal_reason');
  });

  // 2. Restore the original (narrower) constraint.
  await knex.raw(`
    DO $$
    DECLARE
      cname TEXT;
    BEGIN
      SELECT conname
        INTO cname
        FROM pg_constraint
       WHERE conrelid = 'email_escalation_work_items'::regclass
         AND contype  = 'c'
         AND pg_get_constraintdef(oid) LIKE '%workflow_status%';
      IF cname IS NOT NULL THEN
        EXECUTE format('ALTER TABLE email_escalation_work_items DROP CONSTRAINT %I', cname);
      END IF;
    END
    $$;
  `);

  await knex.raw(`
    ALTER TABLE email_escalation_work_items
      ADD CONSTRAINT email_escalation_work_items_workflow_status_check
      CHECK (workflow_status IN ('OPEN', 'ACKNOWLEDGED', 'RESOLVED', 'CLOSED'))
  `);
}
