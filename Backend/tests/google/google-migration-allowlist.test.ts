import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import {
  ALLOWLISTED_GOOGLE_MIGRATION,
  ALLOWLISTED_GOOGLE_MIGRATIONS,
  createAllowlistedMigrationSource,
  preflightAllowlistedMigration,
  runAllowlistedMigration,
} from '../../src/scripts/google-migration-allowlist';

const migration = { up: jest.fn(async () => undefined) };

const databaseWith = (rows: Array<{ name: string }> = []) => Object.assign(
  jest.fn(() => ({ select: jest.fn(async () => rows) })),
  { migrate: { latest: jest.fn(async (..._args: unknown[]): Promise<[number, string[]]> => [1, [ALLOWLISTED_GOOGLE_MIGRATION]]) } },
);

describe('Google migration allow-list runner', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('exposes exactly migration 026, preserving deterministic ordering', async () => {
    const source = createAllowlistedMigrationSource(migration);
    const entries = await source.getMigrations(['.ts']);
    expect(entries).toHaveLength(1);
    expect(source.getMigrationName(entries[0])).toBe(ALLOWLISTED_GOOGLE_MIGRATION);
    await expect(source.getMigration(entries[0])).resolves.toBe(migration);
  });

  it('rejects any migration outside the explicit allow-list', async () => {
    await expect(preflightAllowlistedMigration(databaseWith() as never, '020.ts'))
      .rejects.toThrow('not allow-listed');
  });

  it('allows migration 027 while continuing to expose exactly one source entry', async () => {
    const name = ALLOWLISTED_GOOGLE_MIGRATIONS['027'];
    const source = createAllowlistedMigrationSource(migration, name);
    const entries = await source.getMigrations(['.ts']);
    expect(entries).toHaveLength(1);
    expect(source.getMigrationName(entries[0])).toBe(name);
    await expect(preflightAllowlistedMigration(databaseWith() as never, name))
      .resolves.toMatchObject({ requested: name, willExecute: [name], unrelatedExecution: [] });
  });

  it('reports dry-run work without invoking Knex', async () => {
    const database = databaseWith();
    const result = await runAllowlistedMigration(
      database as never,
      createAllowlistedMigrationSource(migration),
      { dryRun: true },
    );
    expect(result.willExecute).toEqual([ALLOWLISTED_GOOGLE_MIGRATION]);
    expect(database.migrate.latest).not.toHaveBeenCalled();
  });

  it('does not rerun a completed migration', async () => {
    const database = databaseWith([{ name: ALLOWLISTED_GOOGLE_MIGRATION }]);
    const result = await runAllowlistedMigration(
      database as never,
      createAllowlistedMigrationSource(migration),
    );
    expect(result.completed).toBe(true);
    expect(result.executed).toEqual([]);
    expect(database.migrate.latest).not.toHaveBeenCalled();
  });

  it('passes only the custom source and rejects unexpected execution results', async () => {
    const database = databaseWith();
    const source = createAllowlistedMigrationSource(migration);
    const result = await runAllowlistedMigration(database as never, source);
    expect(result.executed).toEqual([ALLOWLISTED_GOOGLE_MIGRATION]);
    expect(database.migrate.latest).toHaveBeenCalledWith({
      migrationSource: source,
      disableMigrationsListValidation: true,
      disableTransactions: true,
    });

    database.migrate.latest.mockResolvedValueOnce([1, ['unexpected.ts']]);
    await expect(runAllowlistedMigration(database as never, source))
      .rejects.toThrow('unexpected migration result');
  });

  it('propagates migration failures without retrying or altering history', async () => {
    const database = databaseWith();
    database.migrate.latest.mockRejectedValueOnce(new Error('migration failed'));
    await expect(runAllowlistedMigration(
      database as never,
      createAllowlistedMigrationSource(migration),
    )).rejects.toThrow('migration failed');
    expect(database.migrate.latest).toHaveBeenCalledTimes(1);
  });
});
