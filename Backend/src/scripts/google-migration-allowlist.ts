import path from 'path';
import type { Knex } from 'knex';
import { db } from '../database';

export const ALLOWLISTED_GOOGLE_MIGRATIONS = {
  '026': '20261015150000_026_google_gmail_thread_state.ts',
  '027': '20261015160000_027_google_gmail_backfill_keyset_index.ts',
} as const;
export const ALLOWLISTED_GOOGLE_MIGRATION = ALLOWLISTED_GOOGLE_MIGRATIONS['026'];

export interface MigrationPlan {
  requested: string;
  completed: boolean;
  willExecute: string[];
  unrelatedExecution: string[];
}

export interface MigrationRunResult extends MigrationPlan {
  dryRun: boolean;
  executed: string[];
}

interface AllowlistedMigrationSpec {
  name: string;
  migration: Knex.Migration;
}

export interface AllowlistedMigrationSource extends Knex.MigrationSource<AllowlistedMigrationSpec> {}

/** Builds a source containing exactly one migration; no filesystem discovery occurs. */
export const createAllowlistedMigrationSource = (
  migration: Knex.Migration,
  migrationName: string = ALLOWLISTED_GOOGLE_MIGRATION,
): AllowlistedMigrationSource => ({
  getMigrations: async () => [{ name: migrationName, migration }],
  getMigrationName: (entry) => entry.name,
  getMigration: async (entry) => entry.migration,
});

const completedNames = async (database: Knex): Promise<Set<string>> => {
  const rows = await database('knex_migrations').select('name') as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
};

export const preflightAllowlistedMigration = async (
  database: Knex,
  migrationName: string = ALLOWLISTED_GOOGLE_MIGRATION,
): Promise<MigrationPlan> => {
  if (!(Object.values(ALLOWLISTED_GOOGLE_MIGRATIONS) as string[]).includes(migrationName)) {
    throw new Error(`Migration is not allow-listed: ${migrationName}`);
  }
  const completed = (await completedNames(database)).has(migrationName);
  return {
    requested: migrationName,
    completed,
    willExecute: completed ? [] : [migrationName],
    unrelatedExecution: [],
  };
};

export const runAllowlistedMigration = async (
  database: Knex,
  source: AllowlistedMigrationSource,
  options: { dryRun?: boolean; migrationName?: string } = {},
): Promise<MigrationRunResult> => {
  const migrationName = options.migrationName ?? ALLOWLISTED_GOOGLE_MIGRATION;
  const plan = await preflightAllowlistedMigration(database, migrationName);
  if (options.dryRun || plan.completed) return { ...plan, dryRun: options.dryRun === true, executed: [] };

  // Validation is disabled only because applied Telecom migration source files
  // are absent locally. The custom source still contains exactly one migration.
  const result = await database.migrate.latest({
    migrationSource: source,
    disableMigrationsListValidation: true,
    // CREATE INDEX CONCURRENTLY cannot run inside a transaction. The
    // allow-listed source contains only explicitly selected migrations, so
    // disabling the migrator wrapper transaction is safe and intentional.
    disableTransactions: true,
  });
  const executed = Array.isArray(result?.[1]) ? result[1] as string[] : [];
  if (executed.some((name) => name !== migrationName)) {
    throw new Error('Allow-listed migration runner detected an unexpected migration result.');
  }
  return { ...plan, dryRun: false, executed };
};

const loadAllowlistedMigration = (migrationName: string): Knex.Migration => {
  const migrationPath = path.resolve(__dirname, '../../migrations', migrationName);
  // This script is invoked with ts-node so the TypeScript migration remains the
  // single source of truth and no compiled migration copy is created.
  const loaded = require(migrationPath) as { up?: Knex.Migration['up']; down?: Knex.Migration['down'] };
  if (typeof loaded.up !== 'function') throw new Error(`Allow-listed migration ${migrationName} has no up() export.`);
  return { up: loaded.up, ...(loaded.down ? { down: loaded.down } : {}) };
};

const main = async (): Promise<void> => {
  const argv = process.argv.slice(2);
  const migrationArg = argv[argv.indexOf('--migration') + 1];
  const migrationName = migrationArg ? ALLOWLISTED_GOOGLE_MIGRATIONS[migrationArg as keyof typeof ALLOWLISTED_GOOGLE_MIGRATIONS] : undefined;
  if (!migrationName) throw new Error('Only allow-listed Google migrations 026 or 027 are accepted.');
  const result = await runAllowlistedMigration(
    db,
    createAllowlistedMigrationSource(loadAllowlistedMigration(migrationName), migrationName),
    { dryRun: argv.includes('--dry-run'), migrationName },
  );
  console.info(JSON.stringify({
    requested: result.requested,
    completed: result.completed,
    dryRun: result.dryRun,
    willExecute: result.willExecute,
    executed: result.executed,
    unrelatedExecution: result.unrelatedExecution,
  }));
  await db.destroy();
};

if (require.main === module) {
  main().catch(async () => {
    await db.destroy().catch(() => undefined);
    process.exitCode = 1;
  });
}
