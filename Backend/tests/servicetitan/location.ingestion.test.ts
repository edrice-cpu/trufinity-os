import { describe, expect, it } from '@jest/globals';
import { LocationExportApi, LocationRawRepository, InvalidLocationRecord, ServiceTitanLocationIngestionService } from '../../src/modules/servicetitan/ingestion/location.ingestion';
import { CustomerSyncInProgressError } from '../../src/modules/servicetitan/ingestion/customer.ingestion';

type Stored = { sourceId: string; payload: Record<string, unknown>; isLatest: boolean };

class FakeRepository implements LocationRawRepository {
  public records: Stored[] = [];
  public errors: InvalidLocationRecord[] = [];
  public calls: Array<Record<string, unknown>> = [];
  public continuation: string | null = null;
  public lockAvailable = true;
  public lockHeld = false;
  public status = 'RUNNING';
  public failCommit = false;
  public failMetadata = false;

  public async withExclusiveLock<T>(work: (repository: LocationRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable || this.lockHeld) throw new CustomerSyncInProgressError();
    this.lockHeld = true;
    try { return await work(this); } finally { this.lockHeld = false; }
  }
  public async recoverInterruptedRuns(): Promise<void> { this.calls.push({ recover: true }); }
  public async createSyncRun(): Promise<string> { this.calls.push({ create: true }); return 'location-run'; }
  public async getContinuation(): Promise<string | null> { return this.continuation; }
  public async commitBatch(syncRunId: string, records: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidLocationRecord[]): Promise<void> {
    if (this.failCommit) throw new Error('database failure');
    for (const record of records) {
      this.records.filter((item) => item.sourceId === record.sourceId && item.isLatest).forEach((item) => { item.isLatest = false; });
      this.records.push({ sourceId: record.sourceId, payload: record.payload, isLatest: true });
    }
    this.errors.push(...errors);
    void syncRunId;
  }
  public async updateContinuation(continuation: string | null): Promise<void> { if (this.failMetadata) throw new Error('metadata failure'); this.continuation = continuation; }
  public async completeSyncRun(): Promise<void> { this.status = 'COMPLETED'; }
  public async failSyncRun(): Promise<void> { this.status = 'FAILED'; }
}

class FakeApi implements LocationExportApi {
  public calls: Array<{ params: Record<string, unknown> | undefined }> = [];
  public constructor(private readonly responses: unknown[]) {}
  public async get<T>(_endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ params });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

describe('ServiceTitan location raw ingestion', () => {
  it('uses the export endpoint with no initial from and persists valid locations', async () => {
    const api = new FakeApi([{ hasMore: false, data: [{ id: 21, name: 'location', nested: { active: true } }] }]);
    const repository = new FakeRepository();
    await new ServiceTitanLocationIngestionService(api, repository).run();
    expect(api.calls[0].params).toEqual({});
    expect(repository.records[0]).toMatchObject({ sourceId: '21', payload: { id: 21, name: 'location', nested: { active: true } }, isLatest: true });
    expect(repository.status).toBe('COMPLETED');
  });

  it('passes continueFrom as from for the next export batch', async () => {
    const api = new FakeApi([{ hasMore: true, continueFrom: 'location-cursor', data: [{ id: 1 }] }, { hasMore: false, data: [{ id: 2 }] }]);
    const repository = new FakeRepository();
    await new ServiceTitanLocationIngestionService(api, repository).run();
    expect(api.calls.map((call) => call.params)).toEqual([{}, { from: 'location-cursor' }]);
    expect(repository.records).toHaveLength(2);
  });

  it('maintains historical versions and is_latest', async () => {
    const repository = new FakeRepository();
    await new ServiceTitanLocationIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, name: 'old' }] }]), repository).run();
    await new ServiceTitanLocationIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, name: 'new' }] }]), repository).run();
    expect(repository.records).toHaveLength(2);
    expect(repository.records[0].isLatest).toBe(false);
    expect(repository.records[1]).toMatchObject({ isLatest: true, payload: { name: 'new' } });
  });

  it('records malformed locations in sync_errors', async () => {
    const repository = new FakeRepository();
    await new ServiceTitanLocationIngestionService(new FakeApi([{ hasMore: false, data: [{ name: 'missing id' }, { id: 4 }] }]), repository).run();
    expect(repository.errors).toHaveLength(1);
    expect(repository.records).toHaveLength(1);
  });

  it('marks API failures failed and releases the lock', async () => {
    const repository = new FakeRepository();
    await expect(new ServiceTitanLocationIngestionService(new FakeApi([new Error('ServiceTitan API Error: [400]')]), repository).run()).rejects.toThrow('ServiceTitan location export failed');
    expect(repository.status).toBe('FAILED');
    expect(repository.lockHeld).toBe(false);
  });

  it('marks metadata failures failed without advancing the cursor', async () => {
    const repository = new FakeRepository();
    repository.failMetadata = true;
    await expect(new ServiceTitanLocationIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 8 }] }]), repository).run()).rejects.toThrow('ServiceTitan location export failed');
    expect(repository.continuation).toBeNull();
    expect(repository.status).toBe('FAILED');
  });

  it('rejects lock contention', async () => {
    const repository = new FakeRepository();
    repository.lockAvailable = false;
    await expect(new ServiceTitanLocationIngestionService(new FakeApi([]), repository).run()).rejects.toThrow('already running');
  });

  it('retries transient errors without changing the cursor', async () => {
    const repository = new FakeRepository();
    const api = new FakeApi([new Error('ServiceTitan API Error: [503]'), { hasMore: false, data: [{ id: 6 }] }]);
    await new ServiceTitanLocationIngestionService(api, repository).run();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0].params).toEqual(api.calls[1].params);
  });
});
