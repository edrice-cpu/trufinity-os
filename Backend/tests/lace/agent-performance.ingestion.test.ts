import { describe, expect, it } from '@jest/globals';
import {
  AgentPerformanceRawRepository,
  AgentPerformanceRawRecord,
  AgentPerformanceSyncInProgressError,
  InvalidAgentPerformanceRecord,
  LaceAgentPerformanceIngestionService,
} from '../../src/modules/lace/ingestion/agent-performance.ingestion';
import type { LaceObjectStore } from '../../src/modules/lace/s3.client';
import type { LaceS3Object } from '../../src/modules/lace/lace.types';

type StoredRecord = { sourceId: string; payload: Record<string, unknown>; isLatest: boolean };

class FakeRepository implements AgentPerformanceRawRepository {
  public runStatus = 'RUNNING';
  public records: StoredRecord[] = [];
  public errors: InvalidAgentPerformanceRecord[] = [];
  public lockAvailable = true;
  public lockHeld = false;

  public async withExclusiveLock<T>(work: (repository: AgentPerformanceRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable || this.lockHeld) throw new AgentPerformanceSyncInProgressError('agent_performance');
    this.lockHeld = true;
    try {
      return await work(this);
    } finally {
      this.lockHeld = false;
    }
  }
  public async recoverInterruptedRuns(): Promise<void> {}
  public async createSyncRun(): Promise<string> {
    return 'run-1';
  }
  public async isFileIngested(): Promise<boolean> {
    return false;
  }
  public async commitFile(
    _syncRunId: string,
    _file: LaceS3Object,
    _exportType: string,
    records: AgentPerformanceRawRecord[],
    errors: InvalidAgentPerformanceRecord[],
  ): Promise<void> {
    for (const record of records) {
      this.records.filter((stored) => stored.sourceId === record.sourceId && stored.isLatest).forEach((stored) => {
        stored.isLatest = false;
      });
      this.records.push({ ...record, isLatest: true });
    }
    this.errors.push(...errors);
  }
  public async recordFileFailure(): Promise<void> {
    // no-op for these tests
  }
  public async completeSyncRun(_syncRunId: string, _recordsProcessed: number, status: 'COMPLETED' | 'COMPLETED_WITH_ERRORS' = 'COMPLETED'): Promise<void> {
    this.runStatus = status;
  }
  public async failSyncRun(): Promise<void> {
    this.runStatus = 'FAILED';
  }
}

class FakeObjectStore implements LaceObjectStore {
  public constructor(
    private readonly objects: LaceS3Object[],
    private readonly contents: Map<string, string>,
  ) {}
  public async listObjects(): Promise<LaceS3Object[]> {
    return this.objects;
  }
  public async getObjectText(key: string): Promise<string> {
    const text = this.contents.get(key);
    if (text === undefined) throw new Error(`No fixture content for ${key}`);
    return text;
  }
}

const HEADER =
  'Agent name,Agent id,Company,Period,Period start,Period end,Total calls,Analyzed calls,Qualified calls,Qualified %,Booked calls,Booking rate %,Target booking rate %,Variance vs target,Qualified & unbooked,Avg playbook score,Avg handle time (sec),Transferred calls,Transfer rate %,Jobs created,Jobs completed,Jobs cancelled,Invoice subtotal (USD),Revenue per booked call (USD)';
const AGENT_ROW = 'Dana Whitfield,4412,Northwind Plumbing,MONTHLY,2026-07-01,2026-07-31,318,318,241,75.79,214,88.80,90.00,-1.20,27,89.40,371,18,5.66,214,197,17,284350.00,1328.74';
const TENANT_TOTAL_ROW = 'TOTAL / TENANT,,Northwind Home Services,MONTHLY,2026-07-01,2026-07-31,2315,2315,1711,73.91,1482,86.62,90.00,-3.38,229,85.61,346,155,6.70,1482,1366,116,1875130.00,1265.27';

function fileObject(key: string): LaceS3Object {
  return { key, eTag: 'etag-1', lastModified: new Date('2026-08-01T00:00:00Z'), size: 100 };
}

describe('Lace Agent Performance raw ingestion', () => {
  it('keys per-agent rows by Agent id + period, and the tenant rollup row by a synthetic TENANT_TOTAL id', async () => {
    const file = fileObject('agent-performance/2026-07.csv');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${AGENT_ROW}\n${TENANT_TOTAL_ROW}\n`]]));
    const repository = new FakeRepository();

    const result = await new LaceAgentPerformanceIngestionService(objectStore, repository).run();

    expect(result.recordsProcessed).toBe(2);
    expect(repository.records.map((r) => r.sourceId)).toEqual([
      '4412__2026-07-01__2026-07-31',
      'TENANT_TOTAL__2026-07-01__2026-07-31',
    ]);
    expect(repository.errors).toHaveLength(0);
  });

  it('flags a row with no period dates as an error instead of guessing a key', async () => {
    const file = fileObject('agent-performance/2026-07.csv');
    const malformedRow = 'Ghost Agent,9999,Northwind Plumbing,MONTHLY,,,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0';
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${malformedRow}\n`]]));
    const repository = new FakeRepository();

    const result = await new LaceAgentPerformanceIngestionService(objectStore, repository).run();

    expect(result.recordsProcessed).toBe(0);
    expect(repository.errors).toHaveLength(1);
    expect(repository.errors[0].message).toBe('agent_performance row is missing a valid natural key.');
  });
});
