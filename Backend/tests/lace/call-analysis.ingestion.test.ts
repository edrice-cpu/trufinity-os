import { describe, expect, it } from '@jest/globals';
import {
  CallAnalysisRawRepository,
  CallAnalysisRawRecord,
  CallAnalysisSyncInProgressError,
  InvalidCallAnalysisRecord,
  LaceCallAnalysisIngestionService,
} from '../../src/modules/lace/ingestion/call-analysis.ingestion';
import type { LaceObjectStore } from '../../src/modules/lace/s3.client';
import type { LaceS3Object } from '../../src/modules/lace/lace.types';

type StoredRecord = { sourceId: string; payload: Record<string, unknown>; isLatest: boolean; syncRunId: string };

class FakeRepository implements CallAnalysisRawRepository {
  public runStatus = 'RUNNING';
  public records: StoredRecord[] = [];
  public errors: InvalidCallAnalysisRecord[] = [];
  public ingestedFileKeys = new Set<string>();
  public failCommit = false;
  public lockAvailable = true;
  public lockHeld = false;

  public async withExclusiveLock<T>(work: (repository: CallAnalysisRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable || this.lockHeld) throw new CallAnalysisSyncInProgressError('call_analysis');
    this.lockHeld = true;
    try {
      return await work(this);
    } finally {
      this.lockHeld = false;
    }
  }
  public async recoverInterruptedRuns(): Promise<void> {
    this.runStatus = 'RECOVERED';
  }
  public async createSyncRun(): Promise<string> {
    return 'run-1';
  }
  public async isFileIngested(exportType: string, key: string, eTag: string): Promise<boolean> {
    return this.ingestedFileKeys.has(`${exportType}:${key}:${eTag}`);
  }
  public async commitFile(
    syncRunId: string,
    file: LaceS3Object,
    exportType: string,
    records: CallAnalysisRawRecord[],
    errors: InvalidCallAnalysisRecord[],
  ): Promise<void> {
    if (this.failCommit) throw new Error('database unavailable');
    for (const record of records) {
      this.records.filter((stored) => stored.sourceId === record.sourceId && stored.isLatest).forEach((stored) => {
        stored.isLatest = false;
      });
      this.records.push({ ...record, isLatest: true, syncRunId });
    }
    this.errors.push(...errors);
    this.ingestedFileKeys.add(`${exportType}:${file.key}:${file.eTag}`);
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

// Header matches the real live export (report_Lace_CcCallAnalysisExport_DAILY_*.csv),
// which has no standalone "Lace call id" column - see call-analysis.ingestion.ts.
const HEADER =
  'CRM,CSR,Tags,Booked,Company,Campaign,Call link,Qualified,Job number,Objections,CRM call id,CRM tenant id,Customer name,Short summary,Call direction,Customer phone,Duration (sec),Playbook score,Unbooked reason,Existing customer,Cancellation reason,Date received (UTC),Time received (UTC),Date received (Local),Qualification details,Time received (Local)';

function csvRow(callId: string, booked: string, callLink = `https://www.lace.ai/app/call-center-all-calls/${callId}`): string {
  return `SERVICE_TITAN,Dana Whitfield,Appointment Set,${booked},Northwind Plumbing,Organic,${callLink},Yes,JOB-1,,ST-1,0000000000,Jane Doe,"Summary text",Inbound,+1 555-0100,300,90,,yes,,2026-08-24,12:00:00,2026-08-24,"Qualification text",07:00:00`;
}

function fileObject(key: string, eTag: string): LaceS3Object {
  return { key, eTag, lastModified: new Date('2026-08-24T00:00:00Z'), size: 100 };
}

describe('Lace Call Analysis raw ingestion', () => {
  it('ingests rows from a new file keyed by the id embedded in the Call link URL and completes the run', async () => {
    const file = fileObject('call-analysis/2026-08-24.csv', 'etag-1');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${csvRow('90010001', 'Booked')}\n`]]));
    const repository = new FakeRepository();

    const result = await new LaceCallAnalysisIngestionService(objectStore, repository).run();

    expect(result.recordsProcessed).toBe(1);
    expect(result.filesProcessed).toBe(1);
    expect(repository.records[0]).toMatchObject({
      sourceId: '90010001',
      isLatest: true,
      payload: expect.objectContaining({ 'Call link': 'https://www.lace.ai/app/call-center-all-calls/90010001', Booked: 'Booked' }) as unknown,
    });
    expect(repository.runStatus).toBe('COMPLETED');
  });

  it('does not reprocess a file it has already ingested (same key and ETag)', async () => {
    const file = fileObject('call-analysis/2026-08-24.csv', 'etag-1');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${csvRow('90010001', 'Booked')}\n`]]));
    const repository = new FakeRepository();

    await new LaceCallAnalysisIngestionService(objectStore, repository).run();
    repository.runStatus = 'RUNNING';
    const second = await new LaceCallAnalysisIngestionService(objectStore, repository).run();

    expect(second.filesProcessed).toBe(0);
    expect(second.recordsProcessed).toBe(0);
    expect(repository.records).toHaveLength(1);
  });

  it('reprocesses a file when its ETag changes (vendor re-sent a corrected export) and keeps history non-latest', async () => {
    const file1 = fileObject('call-analysis/2026-08-24.csv', 'etag-1');
    const file2 = fileObject('call-analysis/2026-08-24.csv', 'etag-2');
    const objectStore = new FakeObjectStore(
      [file1],
      new Map([[file1.key, `${HEADER}\n${csvRow('90010001', 'Qualified - Not Booked')}\n`]]),
    );
    const repository = new FakeRepository();
    await new LaceCallAnalysisIngestionService(objectStore, repository).run();

    const objectStore2 = new FakeObjectStore(
      [file2],
      new Map([[file2.key, `${HEADER}\n${csvRow('90010001', 'Booked')}\n`]]),
    );
    repository.runStatus = 'RUNNING';
    await new LaceCallAnalysisIngestionService(objectStore2, repository).run();

    expect(repository.records).toHaveLength(2);
    expect(repository.records[0].isLatest).toBe(false);
    expect(repository.records[1]).toMatchObject({ isLatest: true, payload: expect.objectContaining({ Booked: 'Booked' }) as unknown });
  });

  it('records rows missing a Call link (no natural key) as errors and still completes the run', async () => {
    const file = fileObject('call-analysis/2026-08-24.csv', 'etag-1');
    const badRow = csvRow('unused', 'Unbooked', '');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${badRow}\n${csvRow('90010002', 'Booked')}\n`]]));
    const repository = new FakeRepository();

    const result = await new LaceCallAnalysisIngestionService(objectStore, repository).run();

    expect(repository.errors).toHaveLength(1);
    expect(repository.errors[0].message).toBe('call_analysis row is missing a valid natural key.');
    expect(result.recordsProcessed).toBe(1);
    expect(repository.runStatus).toBe('COMPLETED');
  });

  it('marks the run failed and releases the lock when a file commit fails', async () => {
    const file = fileObject('call-analysis/2026-08-24.csv', 'etag-1');
    const objectStore = new FakeObjectStore([file], new Map([[file.key, `${HEADER}\n${csvRow('90010001', 'Booked')}\n`]]));
    const repository = new FakeRepository();
    repository.failCommit = true;

    await expect(new LaceCallAnalysisIngestionService(objectStore, repository).run()).rejects.toThrow(
      'Lace AI call_analysis export ingestion failed.',
    );
    expect(repository.runStatus).toBe('FAILED');
    expect(repository.lockHeld).toBe(false);
  });

  it('rejects lock contention without creating a sync run', async () => {
    const repository = new FakeRepository();
    repository.lockAvailable = false;
    const objectStore = new FakeObjectStore([], new Map());

    await expect(new LaceCallAnalysisIngestionService(objectStore, repository).run()).rejects.toThrow('already running');
    expect(repository.lockHeld).toBe(false);
  });
});
