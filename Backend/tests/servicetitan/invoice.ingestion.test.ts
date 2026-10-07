import { describe, expect, it } from '@jest/globals';
import { InvoiceExportApi, InvoiceRawRepository, InvalidInvoiceRecord, ServiceTitanInvoiceIngestionService } from '../../src/modules/servicetitan/ingestion/invoice.ingestion';
import { CustomerSyncInProgressError } from '../../src/modules/servicetitan/ingestion/customer.ingestion';

class FakeRepository implements InvoiceRawRepository {
  public records: { id: string; latest: boolean }[] = [];
  public errors: InvalidInvoiceRecord[] = [];
  public continuation: string | null = null;
  public lockAvailable = true;
  public lockHeld = false;
  public status = 'RUNNING';
  public failMetadata = false;
  public async withExclusiveLock<T>(work: (repository: InvoiceRawRepository) => Promise<T>): Promise<T> { if (!this.lockAvailable || this.lockHeld) throw new CustomerSyncInProgressError(); this.lockHeld = true; try { return await work(this); } finally { this.lockHeld = false; } }
  public async recoverInterruptedRuns(): Promise<void> { this.status = 'RECOVERED'; }
  public async createSyncRun(): Promise<string> { return 'invoice-run'; }
  public async getContinuation(): Promise<string | null> { return this.continuation; }
  public async commitBatch(_run: string, rows: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidInvoiceRecord[]): Promise<void> { for (const row of rows) { this.records.filter((record) => record.id === row.sourceId && record.latest).forEach((record) => { record.latest = false; }); this.records.push({ id: row.sourceId, latest: true }); } this.errors.push(...errors); }
  public async updateContinuation(continuation: string | null): Promise<void> { if (this.failMetadata) throw new Error('metadata failure'); this.continuation = continuation; }
  public async completeSyncRun(): Promise<void> { this.status = 'COMPLETED'; }
  public async failSyncRun(): Promise<void> { this.status = 'FAILED'; }
}

class FakeApi implements InvoiceExportApi {
  public calls: (Record<string, unknown> | undefined)[] = [];
  public constructor(private readonly responses: unknown[]) {}
  public async get<T>(_endpoint: string, params?: Record<string, unknown>): Promise<T> { this.calls.push(params); const response = this.responses.shift(); if (response instanceof Error) throw response; return response as T; }
}

describe('ServiceTitan invoice raw ingestion', () => {
  it('uses an initial request without from and persists valid invoices', async () => { const api = new FakeApi([{ hasMore: false, data: [{ id: 21, total: 10, nested: { active: true } }] }]); const repository = new FakeRepository(); await new ServiceTitanInvoiceIngestionService(api, repository).run(); expect(api.calls[0]).toEqual({}); expect(repository.records).toEqual([{ id: '21', latest: true }]); expect(repository.status).toBe('COMPLETED'); });
  it('passes continueFrom as from for the next batch', async () => { const api = new FakeApi([{ hasMore: true, continueFrom: 'invoice-cursor', data: [{ id: 1 }] }, { hasMore: false, data: [{ id: 2 }] }]); const repository = new FakeRepository(); await new ServiceTitanInvoiceIngestionService(api, repository).run(); expect(api.calls).toEqual([{}, { from: 'invoice-cursor' }]); });
  it('preserves history and latest state across repeated versions', async () => { const repository = new FakeRepository(); await new ServiceTitanInvoiceIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, total: 1 }] }]), repository).run(); await new ServiceTitanInvoiceIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 7, total: 2 }] }]), repository).run(); expect(repository.records).toEqual([{ id: '7', latest: false }, { id: '7', latest: true }]); });
  it('records malformed invoices as sync errors', async () => { const repository = new FakeRepository(); await new ServiceTitanInvoiceIngestionService(new FakeApi([{ hasMore: false, data: [{ missing: true }, { id: 4 }] }]), repository).run(); expect(repository.errors).toHaveLength(1); expect(repository.records).toHaveLength(1); });
  it('marks API and metadata failures and releases the lock', async () => { const repository = new FakeRepository(); await expect(new ServiceTitanInvoiceIngestionService(new FakeApi([new Error('ServiceTitan API Error: [400]')]), repository).run()).rejects.toThrow('invoice export failed'); expect(repository.status).toBe('FAILED'); expect(repository.lockHeld).toBe(false); repository.status = 'RUNNING'; repository.failMetadata = true; await expect(new ServiceTitanInvoiceIngestionService(new FakeApi([{ hasMore: false, data: [{ id: 8 }] }]), repository).run()).rejects.toThrow('invoice export failed'); });
  it('rejects lock contention and retries transient API errors', async () => { const repository = new FakeRepository(); repository.lockAvailable = false; await expect(new ServiceTitanInvoiceIngestionService(new FakeApi([]), repository).run()).rejects.toThrow('already running'); repository.lockAvailable = true; const api = new FakeApi([new Error('[503]'), { hasMore: false, data: [{ id: 6 }] }]); await new ServiceTitanInvoiceIngestionService(api, repository).run(); expect(api.calls).toHaveLength(2); });
  it('fails malformed continuation responses without persistence', async () => { const repository = new FakeRepository(); await expect(new ServiceTitanInvoiceIngestionService(new FakeApi([{ hasMore: true, data: [{ id: 1 }] }]), repository).run()).rejects.toThrow('invoice export failed'); expect(repository.records).toEqual([]); expect(repository.continuation).toBeNull(); });
});
