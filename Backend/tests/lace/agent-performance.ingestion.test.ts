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

// Real Monthly Agent Performance Report format (report_20261011.csv, emailed by Lace).
const HEADER = 'CSR,Period Start,Period End,Total Calls,Success Ratio,Cancellation Rate,Booked,Qualified,Playbook Score,Most Coaching Needed';
const SEPT_ROW = 'Princess Suzainne Suerte,2026-09-01 04:00:00,2026-09-30 21:00:00,215,80%,4%,45,56,60%,Service Fee Concerns;Customer Needs Time to Decide;Immediate Service Unavailability';
const AUG_ROW = 'Princess Suzainne Suerte,2026-08-01 04:00:00,2026-08-31 21:00:00,226,90%,9%,44,49,63%,Customer Needs Time to Decide;Immediate Service Unavailability;Service Fee Concerns';
// A CSR with no calls that month still gets a (mostly blank) row.
const EMPTY_MONTH_ROW = 'Jane Mapatac,2026-09-01 04:00:00,2026-09-30 21:00:00,0,0,,0,,';

function fileObject(key: string): LaceS3Object {
  return { key, eTag: 'etag-1', lastModified: new Date('2026-08-01T00:00:00Z'), size: 100 };
}

describe('Lace Agent Performance raw ingestion', () => {
  it('keys rows by CSR + Period Start + Period End and keeps the payload exactly as sent', async () => {
    const file = fileObject('manual-upload/report_20261011.csv');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}
${SEPT_ROW}
${AUG_ROW}
${EMPTY_MONTH_ROW}
`]]));
    const repository = new FakeRepository();

    const result = await new LaceAgentPerformanceIngestionService(objectStore, repository).run();

    expect(result.recordsProcessed).toBe(3);
    expect(repository.records.map((r) => r.sourceId)).toEqual([
      'Princess Suzainne Suerte__2026-09-01 04:00:00__2026-09-30 21:00:00',
      'Princess Suzainne Suerte__2026-08-01 04:00:00__2026-08-31 21:00:00',
      'Jane Mapatac__2026-09-01 04:00:00__2026-09-30 21:00:00',
    ]);
    expect(repository.records[0]?.payload).toMatchObject({ 'Success Ratio': '80%', Booked: '45', Qualified: '56' });
    expect(repository.errors).toHaveLength(0);
  });

  it('flags a row with no CSR or period as an error instead of guessing a key', async () => {
    const file = fileObject('manual-upload/report.csv');
    const noCsr = ',2026-09-01 04:00:00,2026-09-30 21:00:00,10,50%,0%,5,10,60%,';
    const noPeriod = 'Ghost Agent,,,0,0,,0,,';
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}
${noCsr}
${noPeriod}
`]]));
    const repository = new FakeRepository();

    const result = await new LaceAgentPerformanceIngestionService(objectStore, repository).run();

    expect(result.recordsProcessed).toBe(0);
    expect(repository.errors).toHaveLength(2);
    expect(repository.errors[0]?.message).toBe('agent_performance row is missing a valid natural key.');
  });
});
