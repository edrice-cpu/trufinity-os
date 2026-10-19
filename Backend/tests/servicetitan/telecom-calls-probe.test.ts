import { describe, expect, it, jest } from '@jest/globals';
import { runTelecomCallsProbe, type TelecomCallsProbeResult } from '../../src/scripts/st_telecom_calls_probe';
import {
  type TelecomCallsExportApi,
  type TelecomCallsRawRepository,
  type InvalidTelecomCallRecord,
  TelecomCallsSyncInProgressError as SyncInProgressError,
} from '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion';

// ---------------------------------------------------------------------------
// Fake API client
// ---------------------------------------------------------------------------

type ApiParams = Record<string, string | number | boolean | undefined>;

class FakeApiClient implements TelecomCallsExportApi {
  public callCount = 0;
  public lastParams: ApiParams | undefined;
  private readonly response: unknown;

  constructor(response: unknown = { data: [], hasMore: false }) {
    this.response = response;
  }

  async get<T>(_endpoint: string, params?: ApiParams): Promise<T> {
    this.callCount++;
    this.lastParams = params;
    return this.response as T;
  }
}

// ---------------------------------------------------------------------------
// Fake repository
// ---------------------------------------------------------------------------

interface StoredRecord {
  sourceId: string;
  payload: Record<string, unknown>;
  syncRunId: string;
}

class FakeRepository implements TelecomCallsRawRepository {
  public records: StoredRecord[] = [];
  public syncRuns: { id: string; status: string; errorMessage?: string; recordsProcessed?: number }[] = [];
  public recoverCalled = false;
  private runCounter = 0;
  private readonly lockAvailable: boolean;

  constructor(lockAvailable = true) {
    this.lockAvailable = lockAvailable;
  }

  async recoverInterruptedRuns(): Promise<void> {
    this.recoverCalled = true;
  }

  async createSyncRun(): Promise<string> {
    const id = `run-probe-${++this.runCounter}`;
    this.syncRuns.push({ id, status: 'RUNNING' });
    return id;
  }

  async completeSyncRun(syncRunId: string, recordsProcessed: number): Promise<void> {
    const run = this.syncRuns.find((r) => r.id === syncRunId);
    if (run) { run.status = 'COMPLETED'; run.recordsProcessed = recordsProcessed; }
  }

  async failSyncRun(syncRunId: string, errorMessage: string): Promise<void> {
    const run = this.syncRuns.find((r) => r.id === syncRunId);
    if (run) { run.status = 'FAILED'; run.errorMessage = errorMessage; }
  }

  async commitBatch(
    syncRunId: string,
    records: { sourceId: string; payload: Record<string, unknown> }[],
    _errors: InvalidTelecomCallRecord[],
  ): Promise<void> {
    for (const record of records) {
      const existingIdx = this.records.findIndex((r) => r.sourceId === record.sourceId);
      const existingPayload = existingIdx >= 0 ? JSON.stringify(this.records[existingIdx].payload) : null;
      const newPayload = JSON.stringify(record.payload);
      if (existingPayload !== null && existingPayload === newPayload) {
        this.records[existingIdx].syncRunId = syncRunId;
      } else {
        if (existingIdx >= 0) this.records.splice(existingIdx, 1);
        this.records.push({ sourceId: record.sourceId, payload: record.payload, syncRunId });
      }
    }
  }

  // CHECKPOINT ISOLATION GUARD: unconditionally throws so any probe code path
  // that calls updateContinuation causes the test to fail with a clear message.
  async getContinuation(): Promise<string | null> {
    return null;
  }

  // CHECKPOINT ISOLATION GUARD: unconditionally throws so any probe code path
  // that calls updateContinuation causes the test to fail with a clear message.
  async updateContinuation(_value: string | null): Promise<void> {
    throw new Error('CHECKPOINT ISOLATION VIOLATION: runTelecomCallsProbe must not call updateContinuation.');
  }

  async withExclusiveLock<T>(fn: (repo: TelecomCallsRawRepository) => Promise<T>): Promise<T> {
    if (!this.lockAvailable) {
      throw new SyncInProgressError('TelecomCall sync is already running.');
    }
    return fn(this);
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ENDPOINT = '/telecom/v2/tenant/2088992281/export/calls';

function makePayload(id: number, extra?: Record<string, unknown>): Record<string, unknown> {
  return { id, duration: '120', direction: 'Inbound', ...extra };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('checkpoint isolation', () => {
  it('does not advance the continuation checkpoint when hasMore is false', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [makePayload(1)], hasMore: false });
    // FakeRepository.updateContinuation throws — if the probe called it, this resolves would reject
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).resolves.toBeDefined();
  });

  it('does not advance the continuation checkpoint when hasMore is true', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [makePayload(1)], hasMore: true });
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).resolves.toBeDefined();
  });

  it('does not advance the checkpoint when the API call throws', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient();
    jest.spyOn(client, 'get').mockRejectedValueOnce(new Error('API timeout'));
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).rejects.toThrow('API timeout');
    // If updateContinuation had been called, FakeRepository would have thrown 'CHECKPOINT ISOLATION VIOLATION'
  });

  it('does not advance the checkpoint when commitBatch throws', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [makePayload(1)], hasMore: false });
    jest.spyOn(repo, 'commitBatch').mockRejectedValueOnce(new Error('DB write error'));
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).rejects.toThrow('DB write error');
  });
});

describe('one-batch limit', () => {
  it('calls the API exactly once regardless of hasMore', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [makePayload(1), makePayload(2)], hasMore: true });
    await runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT);
    expect(client.callCount).toBe(1);
  });

  it('passes the correct from parameter to the API', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [], hasMore: false });
    await runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT);
    expect(client.lastParams).toMatchObject({ from: '2026-10-07' });
  });
});

describe('idempotency', () => {
  it('does not create a new history row when the same payload is stored twice', async () => {
    const repo = new FakeRepository();
    const payload = makePayload(42);
    const client1 = new FakeApiClient({ data: [payload], hasMore: false });
    const client2 = new FakeApiClient({ data: [payload], hasMore: false });

    await runTelecomCallsProbe(client1, repo, '2026-10-07', ENDPOINT);
    const countAfterFirst = repo.records.length;
    await runTelecomCallsProbe(client2, repo, '2026-10-07', ENDPOINT);

    expect(repo.records.length).toBe(countAfterFirst);
    expect(repo.records.filter((r) => r.sourceId === '42')).toHaveLength(1);
  });

  it('creates a new history row when the payload changes', async () => {
    const repo = new FakeRepository();
    const client1 = new FakeApiClient({ data: [makePayload(99, { duration: '60' })], hasMore: false });
    const client2 = new FakeApiClient({ data: [makePayload(99, { duration: '120' })], hasMore: false });

    await runTelecomCallsProbe(client1, repo, '2026-10-07', ENDPOINT);
    await runTelecomCallsProbe(client2, repo, '2026-10-07', ENDPOINT);

    expect(repo.records.filter((r) => r.sourceId === '99')).toHaveLength(1);
    expect(repo.records.find((r) => r.sourceId === '99')?.payload.duration).toBe('120');
  });
});

describe('result shape', () => {
  it('returns correct recordsProcessed and recordsInvalid counts', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({
      data: [makePayload(1), makePayload(2), { id: null }, { noId: true }],
      hasMore: false,
    });
    const result: TelecomCallsProbeResult = await runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT);
    expect(result.recordsProcessed).toBe(2);
    expect(result.recordsInvalid).toBe(2);
    expect(result.hasMore).toBe(false);
  });

  it('marks the sync_run COMPLETED on success', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [makePayload(1)], hasMore: false });
    const result = await runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT);
    const run = repo.syncRuns.find((r) => r.id === result.syncRunId);
    expect(run?.status).toBe('COMPLETED');
  });

  it('marks the sync_run FAILED and rethrows on API error', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient();
    jest.spyOn(client, 'get').mockRejectedValueOnce(new Error('network timeout'));
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).rejects.toThrow('network timeout');
    expect(repo.syncRuns[0]?.status).toBe('FAILED');
    expect(repo.syncRuns[0]?.errorMessage).toContain('network timeout');
  });

  it('marks the sync_run FAILED on malformed API response', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ records: [], more: false });
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).rejects.toThrow(
      'Malformed ServiceTitan Telecom export response.',
    );
    expect(repo.syncRuns[0]?.status).toBe('FAILED');
  });

  it('returns a non-null syncRunId', async () => {
    const repo = new FakeRepository();
    const client = new FakeApiClient({ data: [], hasMore: false });
    const result = await runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT);
    expect(result.syncRunId).toBeTruthy();
  });
});

describe('lock behaviour', () => {
  it('throws SyncInProgressError when the exclusive lock is unavailable', async () => {
    const repo = new FakeRepository(false);
    const client = new FakeApiClient({ data: [], hasMore: false });
    await expect(runTelecomCallsProbe(client, repo, '2026-10-07', ENDPOINT)).rejects.toThrow(
      SyncInProgressError,
    );
  });
});
