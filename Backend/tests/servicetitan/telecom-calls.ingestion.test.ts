import { afterAll, afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { z } from 'zod';
import {
  PostgresTelecomCallsRawRepository,
  ServiceTitanTelecomCallsIngestionService,
  TelecomCallsSyncInProgressError,
  retryDelayMs,
  isNetworkError,
  type TelecomCallsExportApi,
  type TelecomCallsRawRepository,
  type InvalidTelecomCallRecord,
} from '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion';
import { db } from '../../src/database';
import { env } from '../../src/config/env';

// ─── Historical-from env validation (inline schema replica) ──────────────────
// Tests the Zod validation rules applied to SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM
// without importing env.ts (which parses .env at load time). The schema below
// is an exact replica of the production definition in src/config/env.ts.

const historicalFromSchema = z
  .string()
  .regex(
    /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/,
    'must be YYYY-MM-DD with valid month and day',
  )
  .refine((v) => new Date(v).toISOString().slice(0, 10) === v, 'not a valid calendar date')
  .refine((v) => new Date(v) <= new Date(), 'must not be a future date')
  .default('2026-07-10');

describe('SERVICETITAN_TELECOM_CALLS_HISTORICAL_FROM — env validation', () => {
  it('accepts a valid past date', () => {
    expect(historicalFromSchema.parse('2026-07-10')).toBe('2026-07-10');
  });

  it('uses default when undefined', () => {
    expect(historicalFromSchema.parse(undefined)).toBe('2026-07-10');
  });

  it('rejects invalid format — missing leading zero', () => {
    expect(() => historicalFromSchema.parse('2026-7-1')).toThrow();
  });

  it('rejects unexpected suffix', () => {
    expect(() => historicalFromSchema.parse('2026-07-10-EXTRA')).toThrow();
  });

  it('rejects impossible month (13)', () => {
    expect(() => historicalFromSchema.parse('2026-13-01')).toThrow();
  });

  it('rejects impossible day (00)', () => {
    expect(() => historicalFromSchema.parse('2026-07-00')).toThrow();
  });

  it('rejects impossible calendar date (Feb 30)', () => {
    expect(() => historicalFromSchema.parse('2026-02-30')).toThrow();
  });

  it('rejects future date', () => {
    expect(() => historicalFromSchema.parse('2099-01-01')).toThrow();
  });

  it('rejects empty string', () => {
    expect(() => historicalFromSchema.parse('')).toThrow();
  });
});

// ─── Test doubles ────────────────────────────────────────────────────────────

type StoredRecord = { sourceId: string; payload: Record<string, unknown>; isLatest: boolean; syncRunId: string };

class FakeRepository implements TelecomCallsRawRepository {
  public runStatus = 'RUNNING';
  public continuation: string | null = null;
  public metadataUpdates: Array<string | null> = [];
  public records: StoredRecord[] = [];
  public errors: InvalidTelecomCallRecord[] = [];
  public failCommit = false;
  public failMetadata = false;
  public lockAvailable = true;
  public lockHeld = false;

  public async withExclusiveLock<T>(work: (repo: TelecomCallsRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable || this.lockHeld) throw new TelecomCallsSyncInProgressError();
    this.lockHeld = true;
    try { return await work(this); } finally { this.lockHeld = false; }
  }
  public async recoverInterruptedRuns(): Promise<void> { this.runStatus = 'RECOVERED'; }
  public async createSyncRun(): Promise<string> { return 'run-telecom-1'; }
  public async getContinuation(): Promise<string | null> { return this.continuation; }
  public async commitBatch(syncRunId: string, records: { sourceId: string; payload: Record<string, unknown> }[], errors: InvalidTelecomCallRecord[]): Promise<void> {
    if (this.failCommit) throw new Error('database unavailable');
    for (const record of records) {
      const existing = this.records.find((s) => s.sourceId === record.sourceId && s.isLatest);
      if (existing) {
        const payloadChanged = JSON.stringify(existing.payload) !== JSON.stringify(record.payload);
        if (payloadChanged) {
          existing.isLatest = false;
          this.records.push({ ...record, isLatest: true, syncRunId });
        } else {
          // Payload unchanged — update sync_run_id only, no new history row
          existing.syncRunId = syncRunId;
        }
      } else {
        this.records.push({ ...record, isLatest: true, syncRunId });
      }
    }
    this.errors.push(...errors);
  }
  public async updateContinuation(continuation: string | null): Promise<void> {
    if (this.failMetadata) throw new Error('metadata unavailable');
    this.continuation = continuation;
    this.metadataUpdates.push(continuation);
  }
  public async completeSyncRun(): Promise<void> { this.runStatus = 'COMPLETED'; }
  public async failSyncRun(_id: string, _msg: string): Promise<void> { this.runStatus = 'FAILED'; }
}

class FakeApi implements TelecomCallsExportApi {
  public calls: Array<{ endpoint: string; params: Record<string, unknown> | undefined }> = [];
  public constructor(private readonly responses: unknown[]) {}
  public async get<T>(endpoint: string, params?: Record<string, unknown>): Promise<T> {
    this.calls.push({ endpoint, params });
    const response = this.responses.shift();
    if (response instanceof Error) throw response;
    return response as T;
  }
}

const HISTORICAL_FROM = '2026-07-10';

const callRecord = (id: number, overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  id,
  direction: 'Inbound',
  status: 'Completed',
  type: 'Lead',
  duration: 'PT2M30S',
  createdOn: '2026-09-01T10:00:00Z',
  modifiedOn: '2026-09-01T10:05:00Z',
  from: '[redacted]',
  to: '[redacted]',
  recordingUrl: '[redacted]',
  voiceMailPath: null,
  customer: { id: 200 },
  location: { id: 300 },
  job: { id: 400 },
  campaign: { id: 500 },
  agent: { id: 600 },
  businessUnit: { id: 700 },
  ...overrides,
});

const svc = (
  responses: unknown[],
  repo: FakeRepository = new FakeRepository(),
  historicalFrom = HISTORICAL_FROM,
): [ServiceTitanTelecomCallsIngestionService, FakeApi, FakeRepository] => {
  const api = new FakeApi(responses);
  return [new ServiceTitanTelecomCallsIngestionService(api, repo, historicalFrom), api, repo];
};

// ─── Issue 1: Final continuation token preservation ──────────────────────────

describe('Telecom ingestion — final continuation token preservation (Issue 1)', () => {
  it('preserves continueFrom when hasMore is false, storing it as the next checkpoint', async () => {
    const [service, , repo] = svc([
      { hasMore: false, continueFrom: 'final-token', data: [callRecord(1)] },
    ]);
    await service.run();
    // continueFrom must be stored even though hasMore was false
    expect(repo.metadataUpdates).toEqual(['final-token']);
    expect(repo.continuation).toBe('final-token');
  });

  it('next run uses the preserved final token, not the historical start date', async () => {
    const repo = new FakeRepository();
    repo.continuation = 'final-token';
    const [service, api] = svc([
      { hasMore: false, continueFrom: 'next-token', data: [callRecord(2)] },
    ], repo);
    await service.run();
    expect(api.calls[0]!.params).toEqual({ from: 'final-token' });
    expect(repo.continuation).toBe('next-token');
  });

  it('multi-page: preserves each continueFrom in order including the last', async () => {
    const [service, api, repo] = svc([
      { hasMore: true,  continueFrom: 'tok-1', data: [callRecord(1)] },
      { hasMore: true,  continueFrom: 'tok-2', data: [callRecord(2)] },
      { hasMore: false, continueFrom: 'tok-3', data: [callRecord(3)] },
    ]);
    await service.run();
    expect(api.calls.map((c) => c.params)).toEqual([
      { from: HISTORICAL_FROM },
      { from: 'tok-1' },
      { from: 'tok-2' },
    ]);
    expect(repo.metadataUpdates).toEqual(['tok-1', 'tok-2', 'tok-3']);
    expect(repo.continuation).toBe('tok-3');
  });

  it('when final page has no continueFrom, retains the cursor used to fetch that page', async () => {
    // API omits continueFrom on last page — keep current cursor, do not reset to null
    const repo = new FakeRepository();
    repo.continuation = 'stored-cursor';
    const [service, , repoOut] = svc([
      { hasMore: false, data: [callRecord(1)] },
    ], repo);
    await service.run();
    // The cursor used to fetch the batch was 'stored-cursor'; it should be re-persisted
    expect(repoOut.continuation).toBe('stored-cursor');
  });
});

// ─── Issue 2: Bounded initial historical start date ──────────────────────────

describe('Telecom ingestion — bounded initial historical start date (Issue 2)', () => {
  it('uses historicalFrom as `from` param on first run (no saved continuation)', async () => {
    const [service, api] = svc([{ hasMore: false, data: [] }]);
    await service.run();
    expect(api.calls[0]!.params).toEqual({ from: HISTORICAL_FROM });
  });

  it('never omits `from` — always sends either the saved token or the historical date', async () => {
    const [service, api] = svc([{ hasMore: false, data: [] }]);
    await service.run();
    const params = api.calls[0]!.params ?? {};
    expect('from' in params).toBe(true);
    expect(params['from']).toBeTruthy();
  });

  it('uses saved continuation (not historicalFrom) when a checkpoint exists', async () => {
    const repo = new FakeRepository();
    repo.continuation = 'existing-checkpoint';
    const [service, api] = svc([{ hasMore: false, data: [] }], repo);
    await service.run();
    expect(api.calls[0]!.params).toEqual({ from: 'existing-checkpoint' });
  });

  it('an invalid or expired continuation causes a failure — does not silently reset to historicalFrom', async () => {
    // The API returns 4xx for an invalid token. This must propagate as an error,
    // not silently fall back to historicalFrom (which would cause data loss).
    const repo = new FakeRepository();
    repo.continuation = 'expired-token';
    const [service, , repoOut] = svc([
      new Error('ServiceTitan API Error: [400]'),
    ], repo);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    // The stored continuation must NOT have been overwritten
    expect(repoOut.continuation).toBe('expired-token');
    expect(repoOut.metadataUpdates).toEqual([]);
    expect(repoOut.runStatus).toBe('FAILED');
  });
});

// ─── Issue 3: Timestamp mapping ──────────────────────────────────────────────

describe('Telecom ingestion — timestamp mapping (Issue 3)', () => {
  it('createdOn maps to created_on only — no call_received_on in payload extraction', async () => {
    const record = callRecord(500, { createdOn: '2026-09-15T14:00:00Z', modifiedOn: '2026-09-15T15:00:00Z' });
    const [service, , repo] = svc([{ hasMore: false, data: [record] }]);
    await service.run();
    const stored = repo.records[0]!.payload as Record<string, unknown>;
    // Verify verbatim payload is stored
    expect(stored['createdOn']).toBe('2026-09-15T14:00:00Z');
    expect(stored['modifiedOn']).toBe('2026-09-15T15:00:00Z');
    // call_received_on must NOT be injected into the payload
    expect(Object.prototype.hasOwnProperty.call(stored, 'call_received_on')).toBe(false);
  });

  it('null or missing createdOn does not cause ingestion failure', async () => {
    const [service, , repo] = svc([
      { hasMore: false, data: [callRecord(501, { createdOn: null, modifiedOn: null })] },
    ]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(1);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('malformed date string in createdOn does not cause ingestion failure', async () => {
    const [service, , repo] = svc([
      { hasMore: false, data: [callRecord(502, { createdOn: 'not-a-date' })] },
    ]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(1);
    expect(repo.runStatus).toBe('COMPLETED');
  });
});

// ─── Initial export ───────────────────────────────────────────────────────────

describe('Telecom ingestion — initial export', () => {
  it('ingests an initial batch, preserves full payload, and completes the run', async () => {
    const [service, api, repo] = svc([{ hasMore: false, continueFrom: 'c0', data: [callRecord(1001)] }]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(1);
    expect(api.calls[0]!.params).toEqual({ from: HISTORICAL_FROM });
    expect(repo.records[0]!.sourceId).toBe('1001');
    expect(repo.records[0]!.payload).toMatchObject({ id: 1001, direction: 'Inbound', duration: 'PT2M30S' });
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('handles an empty export gracefully and completes with zero records', async () => {
    const [service, , repo] = svc([{ hasMore: false, data: [] }]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(0);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('calls updateContinuation on an empty first export to update last_synced_at', async () => {
    // Even with zero records the scheduler stale-checkpoint monitor must see
    // a fresh last_synced_at — updateContinuation must be called.
    const [service, , repo] = svc([{ hasMore: false, continueFrom: 'empty-tok', data: [] }]);
    await service.run();
    expect(repo.metadataUpdates).toEqual(['empty-tok']);
    expect(repo.continuation).toBe('empty-tok');
    expect(repo.runStatus).toBe('COMPLETED');
  });
});

// ─── Zero-record incremental runs ────────────────────────────────────────────
//
// An incremental run during a quiet period (no new calls since the last sync)
// fetches one page of zero records. The continuation token and last_synced_at
// must both be updated so the stale-checkpoint monitor does not fire a false
// positive.

describe('Telecom ingestion — zero-record incremental runs', () => {
  it('preserves the saved continuation token when the API returns zero new records', async () => {
    const repoIn = new FakeRepository();
    repoIn.continuation = 'saved-cursor';
    const [service, , repoOut] = svc(
      [{ hasMore: false, continueFrom: 'next-cursor', data: [] }],
      repoIn,
    );
    const result = await service.run();
    expect(result.recordsProcessed).toBe(0);
    expect(repoOut.runStatus).toBe('COMPLETED');
    // Token must advance to the API-provided next cursor, not be cleared
    expect(repoOut.continuation).toBe('next-cursor');
    expect(repoOut.metadataUpdates).toEqual(['next-cursor']);
  });

  it('keeps the existing token when the API returns zero records and no new continueFrom', async () => {
    // Some API implementations omit continueFrom when there is no new data.
    // The ingestion service must not clear the stored token in this case.
    const repoIn = new FakeRepository();
    repoIn.continuation = 'preserved-cursor';
    const [service, , repoOut] = svc(
      [{ hasMore: false, data: [] }], // no continueFrom
      repoIn,
    );
    const result = await service.run();
    expect(result.recordsProcessed).toBe(0);
    expect(repoOut.runStatus).toBe('COMPLETED');
    expect(repoOut.continuation).toBe('preserved-cursor');
    // updateContinuation must still be called (updates last_synced_at) with the preserved token
    expect(repoOut.metadataUpdates).toEqual(['preserved-cursor']);
  });

  it('calls updateContinuation exactly once per page even for zero-record pages', async () => {
    // Single zero-record page → exactly one checkpoint write.
    const [service, , repo] = svc([{ hasMore: false, continueFrom: 'tok-z', data: [] }]);
    await service.run();
    expect(repo.metadataUpdates).toHaveLength(1);
  });
});

// ─── Continuation-token pagination ───────────────────────────────────────────

describe('Telecom ingestion — continuation token pagination', () => {
  it('follows continueFrom across multiple batches and commits each continuation atomically', async () => {
    const [service, api, repo] = svc([
      { hasMore: true, continueFrom: 'tok-1', data: [callRecord(1)] },
      { hasMore: false, continueFrom: 'tok-2', data: [callRecord(2)] },
    ]);
    await service.run();
    expect(api.calls.map((c) => c.params)).toEqual([
      { from: HISTORICAL_FROM },
      { from: 'tok-1' },
    ]);
    expect(repo.records.map((r) => r.sourceId)).toEqual(['1', '2']);
    expect(repo.metadataUpdates).toEqual(['tok-1', 'tok-2']);
  });
});

// ─── Duplicate / idempotency ──────────────────────────────────────────────────

describe('Telecom ingestion — duplicate and idempotency', () => {
  it('re-ingesting the same call marks the previous version non-latest', async () => {
    const repo = new FakeRepository();
    const [s1] = svc([{ hasMore: false, data: [callRecord(7, { duration: 'PT1M' })] }], repo);
    await s1.run();
    repo.runStatus = 'RUNNING';
    const [s2] = svc([{ hasMore: false, data: [callRecord(7, { duration: 'PT5M' })] }], repo);
    await s2.run();
    expect(repo.records).toHaveLength(2);
    expect(repo.records[0]!.isLatest).toBe(false);
    expect(repo.records[1]!.payload).toMatchObject({ duration: 'PT5M' });
    expect(repo.records[1]!.isLatest).toBe(true);
  });
});

// ─── Null and partial fields ──────────────────────────────────────────────────

describe('Telecom ingestion — null and partial fields', () => {
  it('handles null customer, agent, job, and recording fields without failing', async () => {
    const [service, , repo] = svc([{
      hasMore: false,
      data: [callRecord(2001, {
        customer: null, location: null, job: null,
        agent: null, businessUnit: null, campaign: null,
        recordingUrl: null, voiceMailPath: null,
        duration: null, status: null, type: null,
      })],
    }]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(1);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('records a missing-id payload as a sync error and still completes', async () => {
    const [service, , repo] = svc([
      { hasMore: false, data: [{ direction: 'Inbound' }, callRecord(3)] },
    ]);
    await service.run();
    expect(repo.errors).toHaveLength(1);
    expect(repo.errors[0]!.message).toBe('TelecomCall payload is missing a valid id.');
    expect(repo.records).toHaveLength(1);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('voiceMailPath (not voiceMailUrl) is preserved verbatim in payload', async () => {
    const r = { ...callRecord(300), voiceMailPath: 'https://example.com/vm/300' };
    const [service, , repo] = svc([{ hasMore: false, data: [r] }]);
    await service.run();
    const payload = repo.records[0]!.payload as Record<string, unknown>;
    expect(payload['voiceMailPath']).toBe('https://example.com/vm/300');
    expect(Object.prototype.hasOwnProperty.call(payload, 'voiceMailUrl')).toBe(false);
  });
});

// ─── Failure and recovery ─────────────────────────────────────────────────────

describe('Telecom ingestion — failure and recovery', () => {
  it('does not advance metadata and marks run failed when commitBatch fails', async () => {
    const repo = new FakeRepository();
    repo.failCommit = true;
    const [service] = svc([{ hasMore: true, continueFrom: 'c1', data: [callRecord(1)] }], repo);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(repo.metadataUpdates).toEqual([]);
    expect(repo.continuation).toBeNull();
    expect(repo.runStatus).toBe('FAILED');
  });

  it('marks run failed when metadata update fails without advancing continuation', async () => {
    const repo = new FakeRepository();
    repo.failMetadata = true;
    const [service] = svc([{ hasMore: false, data: [callRecord(9)] }], repo);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(repo.runStatus).toBe('FAILED');
    expect(repo.metadataUpdates).toEqual([]);
  });

  it('rejects lock contention without creating a sync run', async () => {
    const repo = new FakeRepository();
    repo.lockAvailable = false;
    const [service] = svc([], repo);
    await expect(service.run()).rejects.toThrow('already running');
    expect(repo.lockHeld).toBe(false);
  });

  it('releases lock after API failure and marks run failed', async () => {
    const repo = new FakeRepository();
    const [service] = svc([new Error('ServiceTitan API Error: [400]')], repo);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(repo.runStatus).toBe('FAILED');
    expect(repo.lockHeld).toBe(false);
  });

  it('recovers interrupted RUNNING runs at the start of each execution', async () => {
    const repo = new FakeRepository();
    repo.runStatus = 'RUNNING';
    const [service] = svc([{ hasMore: false, data: [] }], repo);
    await service.run();
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('fails a malformed continuation (hasMore true, continueFrom absent)', async () => {
    const repo = new FakeRepository();
    const [service] = svc([{ hasMore: true, data: [callRecord(1)] }], repo);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(repo.records).toEqual([]);
    expect(repo.metadataUpdates).toEqual([]);
  });
});

// ─── Transient API errors ─────────────────────────────────────────────────────

describe('Telecom ingestion — transient API errors', () => {
  it('retries 503 once and succeeds without changing the cursor', async () => {
    const [service, api, repo] = svc([
      new Error('ServiceTitan API Error: [503]'),
      { hasMore: false, data: [callRecord(4)] },
    ]);
    await service.run();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]!.params).toEqual({ from: HISTORICAL_FROM });
    expect(api.calls[1]!.params).toEqual({ from: HISTORICAL_FROM });
    expect(repo.records).toHaveLength(1);
  });

  it('retries 429 and succeeds on retry', async () => {
    const [service, api, repo] = svc([
      new Error('ServiceTitan API Error: [429]'),
      { hasMore: false, data: [callRecord(5)] },
    ]);
    await service.run();
    expect(api.calls).toHaveLength(2);
    expect(repo.records).toHaveLength(1);
  });

  it('does not retry a non-transient 400 error', async () => {
    const [service, api] = svc([new Error('ServiceTitan API Error: [400]')]);
    await expect(service.run()).rejects.toThrow();
    expect(api.calls).toHaveLength(1);
  });

  it('exhausts retries on persistent 500 and marks run failed', async () => {
    const [service, api, repo] = svc([
      new Error('ServiceTitan API Error: [500]'),
      new Error('ServiceTitan API Error: [500]'),
      new Error('ServiceTitan API Error: [500]'),
    ]);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(api.calls.length).toBe(3);
    expect(repo.runStatus).toBe('FAILED');
  });
});

// ─── Large batches ────────────────────────────────────────────────────────────
//
// The real API returns 5,000 records per page (confirmed by production probe on
// 2026-10-08). PostgreSQL limits a single INSERT to 65,535 bound parameters;
// with 14 columns per row the safe ceiling is floor(65535/14)=4,681 rows.
// commitBatch must chunk the temp-table INSERT to stay within this limit.

describe('Telecom ingestion — large batches', () => {
  it('processes a batch of 3,570 records in a single page', async () => {
    const records = Array.from({ length: 3570 }, (_, i) => callRecord(i + 1));
    const [service, , repo] = svc([{ hasMore: false, continueFrom: 'bulk-tok', data: records }]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(3570);
    expect(repo.runStatus).toBe('COMPLETED');
    expect(repo.continuation).toBe('bulk-tok');
  });

  it('processes a 5,000-record page (production page size) and completes successfully', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => callRecord(i + 1));
    const [service, , repo] = svc([
      { hasMore: true,  continueFrom: 'page-2-tok', data: records },
      { hasMore: false, continueFrom: 'final-tok',  data: [] },
    ]);
    const result = await service.run();
    expect(result.recordsProcessed).toBe(5000);
    expect(repo.runStatus).toBe('COMPLETED');
    expect(repo.records).toHaveLength(5000);
    expect(repo.continuation).toBe('final-tok');
  });

  it('processes two 5,000-record pages and accumulates records correctly', async () => {
    const page1 = Array.from({ length: 5000 }, (_, i) => callRecord(i + 1));
    const page2 = Array.from({ length: 5000 }, (_, i) => callRecord(5001 + i));
    const [service, api, repo] = svc([
      { hasMore: true,  continueFrom: 'tok-p2', data: page1 },
      { hasMore: false, continueFrom: 'tok-end', data: page2 },
    ]);
    const result = await service.run();
    expect(api.calls).toHaveLength(2);
    expect(result.recordsProcessed).toBe(10000);
    expect(repo.records).toHaveLength(10000);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('checkpoint advances only after each full page is committed — not mid-page', async () => {
    const page1 = Array.from({ length: 5000 }, (_, i) => callRecord(i + 1));
    const [service, , repo] = svc([
      { hasMore: true,  continueFrom: 'tok-p2', data: page1 },
      { hasMore: false, continueFrom: 'tok-end', data: [] },
    ]);
    await service.run();
    // Two pages → exactly two checkpoint writes, in page order
    expect(repo.metadataUpdates).toEqual(['tok-p2', 'tok-end']);
  });
});

// ─── Task 3: Loop safety — non-advancing cursor ───────────────────────────────

describe('Telecom ingestion — loop safety (non-advancing cursor)', () => {
  it('throws when hasMore:true and continueFrom equals the current cursor', async () => {
    // If the API returns the same cursor it was given, any subsequent request
    // would repeat forever. The service must detect this and abort.
    const [service, api, repo] = svc([
      { hasMore: true, continueFrom: HISTORICAL_FROM, data: [callRecord(1)] },
      // This second response would only be reached if the loop did not abort
      { hasMore: false, continueFrom: 'tok-2', data: [callRecord(2)] },
    ]);
    // The catch block wraps any internal error with safeFailureMessage, so the
    // caller sees the sanitized form — not the raw internal message.
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    // Only one API call should have been made
    expect(api.calls).toHaveLength(1);
    // No checkpoint should have been written — the batch was never committed
    expect(repo.metadataUpdates).toEqual([]);
    expect(repo.runStatus).toBe('FAILED');
  });

  it('does not trigger loop safety when cursor advances on each page', async () => {
    const [service, api, repo] = svc([
      { hasMore: true,  continueFrom: 'tok-1', data: [callRecord(1)] },
      { hasMore: true,  continueFrom: 'tok-2', data: [callRecord(2)] },
      { hasMore: false, continueFrom: 'tok-3', data: [callRecord(3)] },
    ]);
    await service.run();
    expect(api.calls).toHaveLength(3);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('loop safety only fires on hasMore:true — a repeated token on the final page is not an error', async () => {
    // The final page (hasMore: false) may return a continueFrom equal to the
    // token used to fetch it in some API implementations. This is safe.
    const repo = new FakeRepository();
    repo.continuation = 'final-tok';
    const [service, , repoOut] = svc([
      { hasMore: false, continueFrom: 'final-tok', data: [callRecord(1)] },
    ], repo);
    await service.run();
    expect(repoOut.runStatus).toBe('COMPLETED');
    expect(repoOut.continuation).toBe('final-tok');
  });
});

// ─── Task 4: Idempotency / change detection ───────────────────────────────────

describe('Telecom ingestion — idempotency and change detection', () => {
  it('re-ingesting an identical record does not create a new history version', async () => {
    const repo = new FakeRepository();
    const [s1] = svc([{ hasMore: false, data: [callRecord(10)] }], repo);
    await s1.run();
    expect(repo.records).toHaveLength(1);
    repo.runStatus = 'RUNNING';

    const [s2] = svc([{ hasMore: false, data: [callRecord(10)] }], repo);
    await s2.run();
    // Payload identical — no new row
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.isLatest).toBe(true);
  });

  it('re-ingesting a changed record creates a new version and retires the old one', async () => {
    const repo = new FakeRepository();
    const [s1] = svc([{ hasMore: false, data: [callRecord(11, { duration: 'PT1M' })] }], repo);
    await s1.run();
    repo.runStatus = 'RUNNING';

    const [s2] = svc([{ hasMore: false, data: [callRecord(11, { duration: 'PT5M' })] }], repo);
    await s2.run();
    expect(repo.records).toHaveLength(2);
    expect(repo.records[0]!.isLatest).toBe(false);
    expect(repo.records[0]!.payload).toMatchObject({ duration: 'PT1M' });
    expect(repo.records[1]!.isLatest).toBe(true);
    expect(repo.records[1]!.payload).toMatchObject({ duration: 'PT5M' });
  });

  it('retry after lost checkpoint re-presents identical records without new versions', async () => {
    // Simulate: batch committed, checkpoint write failed, run marked failed.
    // Next run re-fetches the same data. Change detection prevents duplicate rows.
    const repo = new FakeRepository();
    const [s1] = svc([{ hasMore: false, data: [callRecord(12)] }], repo);
    await s1.run();
    expect(repo.records).toHaveLength(1);

    // Simulate lost checkpoint: reset continuation to null (as if checkpoint write failed)
    repo.continuation = null;
    repo.runStatus = 'RUNNING';

    const [s2] = svc([{ hasMore: false, data: [callRecord(12)] }], repo);
    await s2.run();
    // Same record re-presented — still only one row
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.isLatest).toBe(true);
  });

  it('mixed batch: unchanged records do not version, changed records do', async () => {
    const repo = new FakeRepository();
    const [s1] = svc([{
      hasMore: false,
      data: [callRecord(20, { duration: 'PT1M' }), callRecord(21, { duration: 'PT2M' })],
    }], repo);
    await s1.run();
    expect(repo.records).toHaveLength(2);
    repo.runStatus = 'RUNNING';

    // id 20: unchanged; id 21: duration changed
    const [s2] = svc([{
      hasMore: false,
      data: [callRecord(20, { duration: 'PT1M' }), callRecord(21, { duration: 'PT9M' })],
    }], repo);
    await s2.run();

    const id20Rows = repo.records.filter((r) => r.sourceId === '20');
    const id21Rows = repo.records.filter((r) => r.sourceId === '21');
    expect(id20Rows).toHaveLength(1);              // unchanged: no new version
    expect(id20Rows[0]!.isLatest).toBe(true);
    expect(id21Rows).toHaveLength(2);              // changed: new version
    expect(id21Rows[0]!.isLatest).toBe(false);
    expect(id21Rows[1]!.isLatest).toBe(true);
    expect(id21Rows[1]!.payload).toMatchObject({ duration: 'PT9M' });
  });

  it('sync_run_id is set on unchanged records so they are associated with the current run', async () => {
    // Note: FakeRepository.createSyncRun always returns 'run-telecom-1', so both
    // runs share the same ID in tests. What we verify here is that the unchanged
    // record remains a single row with a syncRunId set (not null).
    const repo = new FakeRepository();
    const [s1] = svc([{ hasMore: false, data: [callRecord(30)] }], repo);
    await s1.run();
    repo.runStatus = 'RUNNING';

    const [s2] = svc([{ hasMore: false, data: [callRecord(30)] }], repo);
    await s2.run();
    // Still exactly one row — no duplicate version created
    expect(repo.records).toHaveLength(1);
    expect(repo.records[0]!.isLatest).toBe(true);
    // syncRunId is populated (the current run associated with this row)
    expect(repo.records[0]!.syncRunId).toBeTruthy();
  });
});

// ─── isNetworkError ───────────────────────────────────────────────────────────

describe('isNetworkError — network error classification', () => {
  it('returns true for AbortError (name set to AbortError, as AbortController signals)', () => {
    // In Node.js 18+ DOMException is an Error subclass; some environments may vary.
    // We set .name directly on a plain Error to test the same code path portably.
    const err = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns true for TypeError: fetch failed (Node.js native fetch network error)', () => {
    const err = new TypeError('fetch failed');
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns true for an Error with code ECONNRESET', () => {
    const err = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns true for an Error with cause.code ETIMEDOUT (Node fetch wraps cause)', () => {
    const cause = Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' });
    const err = Object.assign(new TypeError('fetch failed'), { cause });
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns true for an Error with code EPIPE', () => {
    const err = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
    expect(isNetworkError(err)).toBe(true);
  });

  it('returns false for an HTTP error with [503] status code', () => {
    const err = new Error('ServiceTitan API Error: [503]');
    expect(isNetworkError(err)).toBe(false);
  });

  it('returns false for a generic Error with no code', () => {
    expect(isNetworkError(new Error('unexpected failure'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isNetworkError('string error')).toBe(false);
    expect(isNetworkError(null)).toBe(false);
    expect(isNetworkError(42)).toBe(false);
  });
});

// ─── Network error retry behaviour ────────────────────────────────────────────

describe('Telecom ingestion — network error retry behaviour', () => {
  it('retries an AbortError (timeout) once and succeeds on the second attempt', async () => {
    const abortErr = Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    const [service, api, repo] = svc([
      abortErr,
      { hasMore: false, continueFrom: 'tok-ok', data: [callRecord(9901)] },
    ]);
    const result = await service.run();
    expect(api.calls).toHaveLength(2);
    expect(result.recordsProcessed).toBe(1);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('retries an ECONNRESET error and succeeds on the second attempt', async () => {
    const netErr = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
    });
    const [service, api, repo] = svc([
      netErr,
      { hasMore: false, continueFrom: 'tok-ok', data: [callRecord(9902)] },
    ]);
    await service.run();
    expect(api.calls).toHaveLength(2);
    expect(repo.runStatus).toBe('COMPLETED');
  });

  it('exhausts all retries on persistent network errors and marks run failed', async () => {
    const makeNetErr = () => Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ETIMEDOUT'), { code: 'ETIMEDOUT' }),
    });
    const [service, api, repo] = svc([makeNetErr(), makeNetErr(), makeNetErr()]);
    await expect(service.run()).rejects.toThrow('ServiceTitan telecomcall export failed');
    expect(api.calls).toHaveLength(3);
    expect(repo.runStatus).toBe('FAILED');
  });

  it('does not retry a non-transient TypeError (no network error markers)', async () => {
    const err = new TypeError('Cannot read properties of undefined');
    const [service, api] = svc([err]);
    await expect(service.run()).rejects.toThrow();
    expect(api.calls).toHaveLength(1);
  });
});

// ─── retryDelayMs — exponential backoff ──────────────────────────────────────

describe('retryDelayMs — exponential backoff', () => {
  it('attempt 1 falls between 750 ms and 1250 ms (base 1 s ±25% jitter)', () => {
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(1);
      expect(d).toBeGreaterThanOrEqual(750);
      expect(d).toBeLessThanOrEqual(1250);
    }
  });

  it('attempt 2 falls between 1500 ms and 2500 ms (base 2 s ±25% jitter)', () => {
    for (let i = 0; i < 200; i++) {
      const d = retryDelayMs(2);
      expect(d).toBeGreaterThanOrEqual(1500);
      expect(d).toBeLessThanOrEqual(2500);
    }
  });

  it('caps at 30 s regardless of attempt number', () => {
    // With ±25% jitter the absolute max is 37.5 s; the base is capped at 30 s.
    for (let i = 0; i < 100; i++) {
      expect(retryDelayMs(100)).toBeLessThanOrEqual(37_500);
      expect(retryDelayMs(100)).toBeGreaterThanOrEqual(22_500);
    }
  });

  it('returns a non-negative integer', () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const d = retryDelayMs(attempt);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(d)).toBe(true);
    }
  });
});

// ─── PostgresTelecomCallsRawRepository.commitBatch — DB integration ──────────
//
// These tests hit the real test database (trufinity_test) through the SSH
// tunnel. They verify the set-based SQL logic directly, independent of the
// ingestion service layer that uses FakeRepository above.

const SOURCE_SYSTEM_TEST = `ServiceTitan:${env.SERVICETITAN_TENANT_ID}`;

function makeRecord(id: number, overrides: Record<string, unknown> = {}): {
  sourceId: string;
  payload: Record<string, unknown>;
} {
  return {
    sourceId: String(id),
    payload: {
      id,
      direction: 'Inbound',
      status: 'Completed',
      type: 'Lead',
      duration: '00:02:30',
      createdOn: '2026-10-07T10:00:00Z',
      modifiedOn: '2026-10-07T10:05:00Z',
      customer: { id: 200 },
      location: { id: 300 },
      job: { id: 400 },
      campaign: { id: 500 },
      agent: { id: 600 },
      businessUnit: { id: 700 },
      ...overrides,
    },
  };
}

describe('PostgresTelecomCallsRawRepository.commitBatch — DB integration', () => {
  let repo: PostgresTelecomCallsRawRepository;
  let syncRunId: string;

  beforeEach(async () => {
    // Clean any rows left by a prior interrupted run before setting up fresh state.
    // afterEach runs cleanup too, but db.destroy() in another file's afterAll can
    // close the pool before this file's afterEach executes, leaving dirty rows.
    await db('sync_errors')
      .whereIn('sync_run_id', db('sync_runs').select('id').where({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall' }))
      .delete();
    await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST }).delete();
    await db('sync_runs').where({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall' }).delete();

    repo = new PostgresTelecomCallsRawRepository();
    const rows = await db('sync_runs')
      .insert({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall', status: 'RUNNING' })
      .returning('id') as { id: string }[];
    syncRunId = rows[0]!.id;
  });

  afterEach(async () => {
    await db('sync_errors')
      .whereIn('sync_run_id', db('sync_runs').select('id').where({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall' }))
      .delete();
    await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST }).delete();
    await db('sync_runs').where({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall' }).delete();
  });

  afterAll(async () => {
    await db.destroy();
  });

  it('inserts new records with correct indexed columns and is_latest=true', async () => {
    await repo.commitBatch(syncRunId, [makeRecord(9001)], []);

    const rows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9001' })
      .select('direction', 'call_status', 'call_type', 'is_latest', 'sync_run_id');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      direction: 'Inbound',
      call_status: 'Completed',
      call_type: 'Lead',
      is_latest: true,
      sync_run_id: syncRunId,
    });
  });

  it('does not create a new row when the payload is unchanged (idempotent)', async () => {
    await repo.commitBatch(syncRunId, [makeRecord(9002)], []);
    const countBefore = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9002' }).count<{ count: string }[]>('id as count');

    const rows2 = await db('sync_runs')
      .insert({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall', status: 'RUNNING' })
      .returning('id') as { id: string }[];
    const syncRunId2 = rows2[0]!.id;

    await repo.commitBatch(syncRunId2, [makeRecord(9002)], []);
    const countAfter = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9002' }).count<{ count: string }[]>('id as count');

    expect(countBefore[0]!.count).toBe('1');
    expect(countAfter[0]!.count).toBe('1'); // no new row

    const row = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9002', is_latest: true })
      .first('sync_run_id') as { sync_run_id: string };
    expect(row.sync_run_id).toBe(syncRunId2); // sync_run_id refreshed
  });

  it('creates a new history version when the payload changes', async () => {
    await repo.commitBatch(syncRunId, [makeRecord(9003, { duration: '00:01:00' })], []);

    const rows2 = await db('sync_runs')
      .insert({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall', status: 'RUNNING' })
      .returning('id') as { id: string }[];
    await repo.commitBatch(rows2[0]!.id, [makeRecord(9003, { duration: '00:05:00' })], []);

    const allRows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9003' })
      .orderBy('ingested_at', 'asc')
      .select('is_latest', 'duration');

    expect(allRows).toHaveLength(2);
    expect(allRows[0]).toMatchObject({ is_latest: false, duration: '00:01:00' });
    expect(allRows[1]).toMatchObject({ is_latest: true,  duration: '00:05:00' });
  });

  it('handles a mixed batch: unchanged unchanged, changed records get new versions, new records are inserted', async () => {
    // Initial state: 9010 (unchanged), 9011 (will change)
    await repo.commitBatch(syncRunId, [
      makeRecord(9010, { duration: '00:01:00' }),
      makeRecord(9011, { duration: '00:02:00' }),
    ], []);

    const rows2 = await db('sync_runs')
      .insert({ source_system: SOURCE_SYSTEM_TEST, entity_type: 'TelecomCall', status: 'RUNNING' })
      .returning('id') as { id: string }[];
    const syncRunId2 = rows2[0]!.id;

    await repo.commitBatch(syncRunId2, [
      makeRecord(9010, { duration: '00:01:00' }), // unchanged
      makeRecord(9011, { duration: '00:09:00' }), // changed
      makeRecord(9012),                           // new
    ], []);

    const r9010 = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9010' }).select('is_latest');
    const r9011 = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9011' }).select('is_latest', 'duration').orderBy('ingested_at', 'asc');
    const r9012 = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9012' }).select('is_latest');

    expect(r9010).toHaveLength(1);
    expect(r9010[0]).toMatchObject({ is_latest: true });

    expect(r9011).toHaveLength(2);
    expect(r9011[0]).toMatchObject({ is_latest: false, duration: '00:02:00' });
    expect(r9011[1]).toMatchObject({ is_latest: true,  duration: '00:09:00' });

    expect(r9012).toHaveLength(1);
    expect(r9012[0]).toMatchObject({ is_latest: true });
  });

  it('deduplicates duplicate source_ids in the same batch — last value wins, one is_latest row', async () => {
    // Simulate an API response with source_id 9020 appearing twice.
    // The second occurrence (duration 00:05:00) should win.
    await repo.commitBatch(syncRunId, [
      makeRecord(9020, { duration: '00:01:00' }),
      makeRecord(9020, { duration: '00:05:00' }),
    ], []);

    const rows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, source_id: '9020' })
      .select('is_latest', 'duration');

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ is_latest: true, duration: '00:05:00' });
  });

  it('writes invalid records to sync_errors without affecting raw_st_calls', async () => {
    const errors: InvalidTelecomCallRecord[] = [
      { sourceId: null, message: 'TelecomCall payload is missing a valid id.', payload: { direction: 'Inbound' } },
    ];
    await repo.commitBatch(syncRunId, [], errors);

    const errorRows = await db('sync_errors').where({ sync_run_id: syncRunId }).select('error_message');
    expect(errorRows).toHaveLength(1);
    expect(errorRows[0]!.error_message).toBe('TelecomCall payload is missing a valid id.');

    const callRows = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST }).count<{ count: string }[]>('id as count');
    expect(callRows[0]!.count).toBe('0');
  });

  it('handles an empty records and errors array without error', async () => {
    await expect(repo.commitBatch(syncRunId, [], [])).resolves.toBeUndefined();
    const callRows = await db('raw_st_calls').where({ source_system: SOURCE_SYSTEM_TEST }).count<{ count: string }[]>('id as count');
    expect(callRows[0]!.count).toBe('0');
  });

  it('commits 4,682 records (crosses the 4,681-row chunk boundary) without exceeding pg parameter limit', async () => {
    // 4,682 rows × 14 columns = 65,548 params — exceeds PostgreSQL's 65,535 limit
    // if inserted in a single statement. The chunked insert must split this into two
    // INSERT calls within the same transaction: chunk 1 of 4,681 + chunk 2 of 1.
    const records = Array.from({ length: 4682 }, (_, i) => makeRecord(80000 + i));
    await repo.commitBatch(syncRunId, records, []);

    const rows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, is_latest: true })
      .count<{ count: string }[]>('id as count');
    expect(rows[0]!.count).toBe('4682');
  });

  it('commits a full 5,000-record production page correctly', async () => {
    const records = Array.from({ length: 5000 }, (_, i) => makeRecord(90000 + i));
    await repo.commitBatch(syncRunId, records, []);

    const rows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST, is_latest: true })
      .count<{ count: string }[]>('id as count');
    expect(rows[0]!.count).toBe('5000');
  });

  it('rolls back the entire batch when a mid-transaction error occurs', async () => {
    // Insert record 9030 in the first (clean) run.
    await repo.commitBatch(syncRunId, [makeRecord(9030)], []);

    // Second run: use a non-existent sync_run_id to force an FK violation on sync_errors,
    // which rolls back the entire transaction including any raw_st_calls changes.
    const badSyncRunId = '00000000-0000-0000-0000-000000000000';
    const errors: InvalidTelecomCallRecord[] = [
      { sourceId: null, message: 'forced rollback', payload: {} },
    ];
    // Record 9031 would be inserted if the transaction committed — it must NOT appear.
    await expect(repo.commitBatch(badSyncRunId, [makeRecord(9031)], errors)).rejects.toThrow();

    const rows = await db('raw_st_calls')
      .where({ source_system: SOURCE_SYSTEM_TEST })
      .select('source_id');
    const ids = rows.map((r: { source_id: string }) => r.source_id);
    expect(ids).toContain('9030');
    expect(ids).not.toContain('9031'); // rolled back
  });
});
