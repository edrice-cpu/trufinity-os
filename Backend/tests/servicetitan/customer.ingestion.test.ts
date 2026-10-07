import { describe, expect, it } from '@jest/globals';
import { CustomerExportApi, CustomerRawRepository, CustomerSyncInProgressError, InvalidCustomerRecord, ServiceTitanCustomerIngestionService } from '../../src/modules/servicetitan/ingestion/customer.ingestion';

type StoredRecord = { sourceId: string; payload: Record<string, unknown>; isLatest: boolean; syncRunId: string };

class FakeRepository implements CustomerRawRepository {
  public runStatus = 'RUNNING';
  public continuation: string | null = null;
  public metadataUpdates: Array<string | null> = [];
  public records: StoredRecord[] = [];
  public errors: InvalidCustomerRecord[] = [];
  public failCommit = false;
  public failMetadata = false;
  public lockAvailable = true;
  public lockHeld = false;

  public async withExclusiveLock<T>(work: (repository: CustomerRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable || this.lockHeld) throw new CustomerSyncInProgressError();
    this.lockHeld = true;
    try { return await work(this); } finally { this.lockHeld = false; }
  }
  public async recoverInterruptedRuns(): Promise<void> { this.runStatus = 'RECOVERED'; }
  public async createSyncRun(): Promise<string> { return 'run-1'; }
  public async getContinuation(): Promise<string | null> { return this.continuation; }
  public async commitBatch(syncRunId: string, records: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidCustomerRecord[]): Promise<void> {
    if (this.failCommit) throw new Error('database unavailable');
    for (const record of records) {
      this.records.filter((stored) => stored.sourceId === record.sourceId && stored.isLatest).forEach((stored) => { stored.isLatest = false; });
      this.records.push({ ...record, isLatest: true, syncRunId });
    }
    this.errors.push(...errors);
  }
  public async updateContinuation(continuation: string | null): Promise<void> { if (this.failMetadata) throw new Error('metadata unavailable'); this.continuation = continuation; this.metadataUpdates.push(continuation); }
  public async completeSyncRun(): Promise<void> { this.runStatus = 'COMPLETED'; }
  public async failSyncRun(_syncRunId: string, _message: string): Promise<void> { this.runStatus = 'FAILED'; }
}

class FakeApi implements CustomerExportApi {
  public calls: Array<{ endpoint: string; params: Record<string, unknown> | undefined }> = [];
  public constructor(private readonly responses: unknown[]) {}
  public async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ endpoint, params });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

describe('ServiceTitan customer raw ingestion', () => {
  it('ingests an initial batch, preserves payload, updates metadata, and completes the run', async () => {
    const api = new FakeApi([{ hasMore: false, data: [{ id: 10, name: 'Ada', nested: { value: true } }] }]);
    const repository = new FakeRepository();

    const result = await new ServiceTitanCustomerIngestionService(api, repository).run();

    expect(result.recordsProcessed).toBe(1);
    expect(api.calls[0].params).toEqual({});
    expect(repository.records[0]).toMatchObject({ sourceId: '10', payload: { id: 10, name: 'Ada', nested: { value: true } }, isLatest: true });
    expect(repository.metadataUpdates).toEqual([null]);
    expect(repository.runStatus).toBe('COMPLETED');
  });

  it('follows continueFrom across multiple batches and commits each continuation', async () => {
    const api = new FakeApi([
      { hasMore: true, continueFrom: 'cursor-1', data: [{ id: 1 }] },
      { hasMore: false, data: [{ id: 2 }] },
    ]);
    const repository = new FakeRepository();

    await new ServiceTitanCustomerIngestionService(api, repository).run();

    expect(api.calls.map((call) => call.params)).toEqual([{}, { from: 'cursor-1' }]);
    expect(repository.records.map((record) => record.sourceId)).toEqual(['1', '2']);
    expect(repository.metadataUpdates).toEqual(['cursor-1', null]);
  });

  it('keeps previous history non-latest when a source record is ingested again', async () => {
    const repository = new FakeRepository();
    await new ServiceTitanCustomerIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, name: 'old' }] }]), repository).run();
    repository.runStatus = 'RUNNING';
    await new ServiceTitanCustomerIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, name: 'new' }] }]), repository).run();

    expect(repository.records).toHaveLength(2);
    expect(repository.records[0].isLatest).toBe(false);
    expect(repository.records[1]).toMatchObject({ isLatest: true, payload: { id: 7, name: 'new' } });
  });

  it('records missing source IDs and still completes the run', async () => {
    const api = new FakeApi([{ hasMore: false, data: [{ name: 'missing id' }, { id: 3 }] }]);
    const repository = new FakeRepository();

    await new ServiceTitanCustomerIngestionService(api, repository).run();

    expect(repository.errors).toHaveLength(1);
    expect(repository.errors[0].message).toBe('Customer payload is missing a valid id.');
    expect(repository.records).toHaveLength(1);
    expect(repository.runStatus).toBe('COMPLETED');
  });

  it('does not advance metadata and marks the run failed when a batch cannot commit', async () => {
    const api = new FakeApi([{ hasMore: true, continueFrom: 'cursor-1', data: [{ id: 1 }] }]);
    const repository = new FakeRepository();
    repository.failCommit = true;

    await expect(new ServiceTitanCustomerIngestionService(api, repository).run()).rejects.toThrow('ServiceTitan customer export failed');

    expect(repository.metadataUpdates).toEqual([]);
    expect(repository.continuation).toBeNull();
    expect(repository.runStatus).toBe('FAILED');
    expect(repository.records).toEqual([]);
    expect(repository.lockHeld).toBe(false);
  });

  it('rejects lock contention before creating a sync workflow and releases after success', async () => {
    const repository = new FakeRepository();
    repository.lockAvailable = false;
    await expect(new ServiceTitanCustomerIngestionService(new FakeApi([]), repository).run()).rejects.toThrow('already running');
    expect(repository.lockHeld).toBe(false);
  });

  it('releases the lock after an API failure and marks the run failed', async () => {
    const repository = new FakeRepository();
    const api = new FakeApi([new Error('ServiceTitan API Error: [400]')]);
    await expect(new ServiceTitanCustomerIngestionService(api, repository).run()).rejects.toThrow('ServiceTitan customer export failed');
    expect(repository.runStatus).toBe('FAILED');
    expect(repository.lockHeld).toBe(false);
  });

  it('marks the run failed when metadata update fails without advancing state', async () => {
    const repository = new FakeRepository();
    repository.failMetadata = true;
    await expect(new ServiceTitanCustomerIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 9 }] }]), repository).run()).rejects.toThrow('ServiceTitan customer export failed');
    expect(repository.runStatus).toBe('FAILED');
    expect(repository.metadataUpdates).toEqual([]);
    expect(repository.lockHeld).toBe(false);
  });

  it('fails a malformed continuation response without committing or advancing metadata', async () => {
    const repository = new FakeRepository();
    await expect(new ServiceTitanCustomerIngestionService(new FakeApi([{ hasMore: true, data: [{ id: 1 }] }]), repository).run()).rejects.toThrow('ServiceTitan customer export failed');
    expect(repository.records).toEqual([]);
    expect(repository.metadataUpdates).toEqual([]);
  });

  it('retries transient API errors without changing the request cursor', async () => {
    const repository = new FakeRepository();
    const api = new FakeApi([new Error('ServiceTitan API Error: [503]'), { hasMore: false, data: [{ id: 4 }] }]);
    await new ServiceTitanCustomerIngestionService(api, repository).run();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0].params).toEqual({});
    expect(api.calls[1].params).toEqual({});
    expect(repository.records).toHaveLength(1);
  });
});
