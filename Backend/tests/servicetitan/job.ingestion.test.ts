import { describe, expect, it } from '@jest/globals';
import { JobExportApi, JobRawRepository, InvalidJobRecord, ServiceTitanJobIngestionService } from '../../src/modules/servicetitan/ingestion/job.ingestion';

class Repo implements JobRawRepository { public records: { id: string; latest: boolean }[] = []; public continuation: string | null = null; public errors: InvalidJobRecord[] = []; public status = 'RUNNING'; public lock = true; public held = false; public failMetadata = false;
  public async withExclusiveLock<T>(work: (r: JobRawRepository) => Promise<T>): Promise<T> { if (!this.lock || this.held) throw new Error('already running'); this.held = true; try { return await work(this); } finally { this.held = false; } }
  public async recoverInterruptedRuns(): Promise<void> {}
  public async createSyncRun(): Promise<string> { return 'job-run'; }
  public async getContinuation(): Promise<string | null> { return this.continuation; }
  public async commitBatch(_run: string, rows: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidJobRecord[]): Promise<void> { for (const row of rows) { this.records.filter((x) => x.id === row.sourceId && x.latest).forEach((x) => { x.latest = false; }); this.records.push({ id: row.sourceId, latest: true }); } this.errors.push(...errors); }
  public async updateContinuation(c: string | null): Promise<void> { if (this.failMetadata) throw new Error('metadata failure'); this.continuation = c; }
  public async completeSyncRun(): Promise<void> { this.status = 'COMPLETED'; }
  public async failSyncRun(): Promise<void> { this.status = 'FAILED'; }
}
class Api implements JobExportApi { public calls: (Record<string, unknown> | undefined)[] = []; public constructor(private readonly responses: unknown[]) {} public async get<T>(_e: string, p?: Record<string, unknown>): Promise<T> { this.calls.push(p); const r = this.responses.shift(); if (r instanceof Error) throw r; return r as T; } }
describe('ServiceTitan job ingestion', () => {
  it('ingests initial jobs without from', async () => { const api = new Api([{ hasMore: false, data: [{ id: 1, status: 'open' }] }]); const repo = new Repo(); await new ServiceTitanJobIngestionService(api, repo).run(); expect(api.calls[0]).toEqual({}); expect(repo.records).toEqual([{ id: '1', latest: true }]); expect(repo.status).toBe('COMPLETED'); });
  it('passes continuation to the next batch', async () => { const api = new Api([{ hasMore: true, continueFrom: 'c1', data: [{ id: 1 }] }, { hasMore: false, data: [{ id: 2 }] }]); const repo = new Repo(); await new ServiceTitanJobIngestionService(api, repo).run(); expect(api.calls).toEqual([{}, { from: 'c1' }]); });
  it('versions repeated jobs and records malformed payloads', async () => { const repo = new Repo(); await new ServiceTitanJobIngestionService(new Api([{ hasMore: false, data: [{ id: 3, v: 1 }, { bad: true }] }]), repo).run(); await new ServiceTitanJobIngestionService(new Api([{ hasMore: false, data: [{ id: 3, v: 2 }] }]), repo).run(); expect(repo.records).toEqual([{ id: '3', latest: false }, { id: '3', latest: true }]); expect(repo.errors).toHaveLength(1); });
  it('fails API and metadata errors and releases lock', async () => { const repo = new Repo(); await expect(new ServiceTitanJobIngestionService(new Api([new Error('HTTP 400')]), repo).run()).rejects.toThrow('job export failed'); expect(repo.status).toBe('FAILED'); expect(repo.held).toBe(false); repo.status = 'RUNNING'; repo.failMetadata = true; await expect(new ServiceTitanJobIngestionService(new Api([{ hasMore: false, data: [{ id: 4 }] }]), repo).run()).rejects.toThrow('job export failed'); });
  it('retries transient failures and rejects lock contention', async () => { const repo = new Repo(); const api = new Api([new Error('[503]'), { hasMore: false, data: [{ id: 5 }] }]); await new ServiceTitanJobIngestionService(api, repo).run(); expect(api.calls).toHaveLength(2); repo.lock = false; await expect(new ServiceTitanJobIngestionService(new Api([]), repo).run()).rejects.toThrow('already running'); });
});
