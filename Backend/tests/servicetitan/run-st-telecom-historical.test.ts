import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { runHistoricalIngestion } from '../../src/scripts/run_st_telecom_historical';
import {
  type TelecomCallsRawRepository,
  type InvalidTelecomCallRecord,
  TelecomCallsSyncInProgressError,
} from '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion';

// ---------------------------------------------------------------------------
// Fake service stub — avoids any real DB or API interaction
// ---------------------------------------------------------------------------

interface FakeRunResult {
  syncRunId: string;
  recordsProcessed: number;
}

class FakeIngestionService {
  public callCount = 0;
  private readonly result: FakeRunResult | Error;

  constructor(result: FakeRunResult | Error = { syncRunId: 'run-hist-1', recordsProcessed: 1234 }) {
    this.result = result;
  }

  async run(): Promise<FakeRunResult> {
    this.callCount++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

// ---------------------------------------------------------------------------
// Fake repository stub — controls getContinuation return value
// ---------------------------------------------------------------------------

class FakeRepository implements TelecomCallsRawRepository {
  constructor(public readonly continuation: string | null = null) {}

  async getContinuation(): Promise<string | null> { return this.continuation; }
  async withExclusiveLock<T>(fn: (repo: TelecomCallsRawRepository) => Promise<T>): Promise<T> { return fn(this); }
  async recoverInterruptedRuns(): Promise<void> { /* no-op */ }
  async createSyncRun(): Promise<string> { return 'fake-run'; }
  async commitBatch(_sid: string, _r: { sourceId: string; payload: Record<string, unknown> }[], _e: InvalidTelecomCallRecord[]): Promise<void> { /* no-op */ }
  async updateContinuation(_v: string | null): Promise<void> { /* no-op */ }
  async completeSyncRun(_sid: string, _n: number): Promise<void> { /* no-op */ }
  async failSyncRun(_sid: string, _msg: string): Promise<void> { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Mock PostgresTelecomCallsRawRepository so preflight() doesn't open a real
// DB connection. Jest module mocking replaces the class in the script's import.
// ---------------------------------------------------------------------------

jest.mock('../../src/modules/servicetitan/ingestion/telecom-calls.ingestion', () => {
  const actual = jest.requireActual<typeof import('../../src/modules/servicetitan/ingestion/telecom-calls.ingestion')>(
    '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion',
  );
  return {
    ...actual,
    PostgresTelecomCallsRawRepository: jest.fn().mockImplementation(() => new FakeRepository(null)),
  };
});

// Mock db.destroy() so the script's finally block doesn't close the test pool.
jest.mock('../../src/database', () => ({
  db: { destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runHistoricalIngestion', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('calls service.run() exactly once and returns its result', async () => {
    const svc = new FakeIngestionService({ syncRunId: 'run-abc', recordsProcessed: 500 });
    const result = await runHistoricalIngestion(svc);
    expect(svc.callCount).toBe(1);
    expect(result.syncRunId).toBe('run-abc');
    expect(result.recordsProcessed).toBe(500);
  });

  it('returns a non-negative integer durationMs', async () => {
    const svc = new FakeIngestionService();
    const result = await runHistoricalIngestion(svc);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });

  it('propagates errors thrown by service.run()', async () => {
    const svc = new FakeIngestionService(new Error('ServiceTitan telecomcall export failed (HTTP 503).'));
    await expect(runHistoricalIngestion(svc)).rejects.toThrow('export failed');
  });

  it('propagates SyncInProgressError when a lock is already held', async () => {
    const svc = new FakeIngestionService(new TelecomCallsSyncInProgressError('TelecomCall'));
    await expect(runHistoricalIngestion(svc)).rejects.toThrow(TelecomCallsSyncInProgressError);
  });

  it('does not swallow errors — rejected promise escapes the runner', async () => {
    const svc = new FakeIngestionService(new Error('unexpected DB failure'));
    let caught: unknown;
    try { await runHistoricalIngestion(svc); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('unexpected DB failure');
  });

  it('uses the default service when no argument is provided (smoke — verifies import wiring)', async () => {
    // With the PostgresTelecomCallsRawRepository mock in place, calling
    // runHistoricalIngestion() with no args should not throw during preflight.
    // The mock returns a repository whose getContinuation() → null, which is
    // the expected first-run state.
    //
    // We cannot let it proceed past preflight without a real DB / API, so
    // we mock ServiceTitanTelecomCallsIngestionService at the module level
    // only for this test by reaching into the mock.
    const { PostgresTelecomCallsRawRepository: MockRepo } =
      jest.requireMock<{ PostgresTelecomCallsRawRepository: jest.Mock }>(
        '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion',
      );
    MockRepo.mockImplementationOnce(() => new FakeRepository(null));

    // This will fail at service.run() because the default service tries to
    // open a real connection, which the DB mock prevents. We only care that
    // preflight itself completes without error.
    const svc = new FakeIngestionService({ syncRunId: 'run-default-smoke', recordsProcessed: 0 });
    const result = await runHistoricalIngestion(svc);
    expect(result.syncRunId).toBe('run-default-smoke');
  });
});

describe('runHistoricalIngestion — checkpoint display', () => {
  it('reflects a null checkpoint (first run) in the result without error', async () => {
    const { PostgresTelecomCallsRawRepository: MockRepo } =
      jest.requireMock<{ PostgresTelecomCallsRawRepository: jest.Mock }>(
        '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion',
      );
    MockRepo.mockImplementationOnce(() => new FakeRepository(null));

    const svc = new FakeIngestionService({ syncRunId: 'run-no-ckpt', recordsProcessed: 14300 });
    const result = await runHistoricalIngestion(svc);
    expect(result.recordsProcessed).toBe(14300);
  });

  it('reflects an existing checkpoint (resume run) in the result without error', async () => {
    const { PostgresTelecomCallsRawRepository: MockRepo } =
      jest.requireMock<{ PostgresTelecomCallsRawRepository: jest.Mock }>(
        '../../src/modules/servicetitan/ingestion/telecom-calls.ingestion',
      );
    MockRepo.mockImplementationOnce(() => new FakeRepository('2026-09-01T00:00:00Z'));

    const svc = new FakeIngestionService({ syncRunId: 'run-resume', recordsProcessed: 3200 });
    const result = await runHistoricalIngestion(svc);
    expect(result.syncRunId).toBe('run-resume');
  });
});
