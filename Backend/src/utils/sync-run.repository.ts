import type { Knex } from 'knex';
import { db } from '../database';
import { withAdvisoryLock } from './advisory-lock';
import { SYNC_RUNS_TABLE, SYNC_RUN_STATUS, type SyncRunStatus } from './sync-run.constants';

export type { SyncRunStatus };

// Base for a raw-ingestion module's repository: the advisory-lock /
// sync_runs bookkeeping that Lace and ServiceTitan (and, previously,
// duplicated between them near line-for-line) both need. Subclasses add
// their own entity-specific persistence (commitFile/commitBatch, etc.).
export abstract class BaseSyncRunRepository {
  protected constructor(
    protected readonly sourceSystem: string,
    protected readonly entityType: string,
    private readonly lockKey: string,
    protected readonly database: Knex = db,
  ) {}

  // Error thrown when the advisory lock is already held by another run.
  protected abstract lockUnavailableError(): Error;

  public async withExclusiveLock<T>(work: (repo: this) => Promise<T>): Promise<T> {
    return withAdvisoryLock(this.database, this.lockKey, () => this.lockUnavailableError(), () => work(this));
  }

  public async recoverInterruptedRuns(): Promise<void> {
    await this.database(SYNC_RUNS_TABLE)
      .where({ source_system: this.sourceSystem, entity_type: this.entityType, status: SYNC_RUN_STATUS.RUNNING })
      .update({
        status: SYNC_RUN_STATUS.FAILED,
        error_message: `Recovered interrupted ${this.sourceSystem} ${this.entityType} sync run.`,
        completed_at: this.database.fn.now(),
      });
  }

  public async createSyncRun(): Promise<string> {
    const rows: unknown = await this.database(SYNC_RUNS_TABLE)
      .insert({ source_system: this.sourceSystem, entity_type: this.entityType, status: SYNC_RUN_STATUS.RUNNING })
      .returning('id');
    if (!Array.isArray(rows) || rows.length === 0 || typeof rows[0] !== 'object' || rows[0] === null || !('id' in rows[0])) {
      throw new Error(`Unable to create ${this.sourceSystem} sync run.`);
    }
    const id = (rows[0] as { id?: unknown }).id;
    if (typeof id !== 'string') throw new Error(`Unable to create ${this.sourceSystem} sync run.`);
    return id;
  }

  public async completeSyncRun(syncRunId: string, recordsProcessed: number, status: SyncRunStatus = SYNC_RUN_STATUS.COMPLETED): Promise<void> {
    await this.database(SYNC_RUNS_TABLE).where({ id: syncRunId }).update({ status, records_processed: recordsProcessed, completed_at: this.database.fn.now() });
  }

  public async failSyncRun(syncRunId: string, safeMessage: string): Promise<void> {
    await this.database(SYNC_RUNS_TABLE).where({ id: syncRunId }).update({ status: SYNC_RUN_STATUS.FAILED, error_message: safeMessage, completed_at: this.database.fn.now() });
  }
}
