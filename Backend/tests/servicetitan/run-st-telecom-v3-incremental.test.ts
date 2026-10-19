// No real database connection — all DB and service calls are served by mocks below.
import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { runV3IncrementalSync } from '../../src/scripts/run_st_telecom_v3_incremental';
import { V3SyncInProgressError } from '../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion';

// ---------------------------------------------------------------------------
// Fake service stub — avoids any real DB or API interaction
// ---------------------------------------------------------------------------

interface FakeRunResult {
  syncRunId: string;
  recordsProcessed: number;
}

class FakeV3Service {
  public callCount = 0;
  private readonly result: FakeRunResult | Error;

  constructor(result: FakeRunResult | Error = { syncRunId: 'run-v3-1', recordsProcessed: 738 }) {
    this.result = result;
  }

  async run(): Promise<FakeRunResult> {
    this.callCount++;
    if (this.result instanceof Error) throw this.result;
    return this.result;
  }
}

// ---------------------------------------------------------------------------
// Mock PostgresV3EnrichmentRepository so preflight() never opens a real DB.
// ---------------------------------------------------------------------------

// Default: checkpoint present and valid (ISO-8601 date prefix "2026-10-14…")
const mockGetContinuation = jest.fn<() => Promise<string | null>>().mockResolvedValue(
  '2026-10-14T09:04:33.000Z',
);

jest.mock('../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion', () => {
  const actual = jest.requireActual<
    typeof import('../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion')
  >('../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion');
  return {
    ...actual,
    PostgresV3EnrichmentRepository: jest.fn().mockImplementation(() => ({
      getContinuation: mockGetContinuation,
    })),
  };
});

// Mock db.destroy() so the script's finally block doesn't close the test pool.
jest.mock('../../src/database', () => ({
  db: { destroy: jest.fn<() => Promise<void>>().mockResolvedValue(undefined) },
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runV3IncrementalSync — checkpoint guards', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContinuation.mockResolvedValue('2026-10-14T09:04:33.000Z');
  });

  it('throws when no V3 checkpoint exists (null)', async () => {
    mockGetContinuation.mockResolvedValue(null);
    const svc = new FakeV3Service();
    await expect(runV3IncrementalSync(svc)).rejects.toThrow(
      'No V3 checkpoint found. Refusing to run historical backfill.',
    );
    expect(svc.callCount).toBe(0);
  });

  it('throws when checkpoint is not a parseable ISO-8601 timestamp', async () => {
    mockGetContinuation.mockResolvedValue('not-a-date');
    const svc = new FakeV3Service();
    await expect(runV3IncrementalSync(svc)).rejects.toThrow('Invalid V3 checkpoint timestamp.');
    expect(svc.callCount).toBe(0);
  });

  it('throws when checkpoint is an empty string', async () => {
    mockGetContinuation.mockResolvedValue('');
    const svc = new FakeV3Service();
    // Empty string: getContinuation returns '', not null — preflight's null guard fires
    // only for null; Date.parse('') returns NaN → triggers invalid-timestamp guard.
    await expect(runV3IncrementalSync(svc)).rejects.toThrow(/checkpoint/i);
    expect(svc.callCount).toBe(0);
  });
});

describe('runV3IncrementalSync — delegation and result', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContinuation.mockResolvedValue('2026-10-14T09:04:33.000Z');
  });

  it('calls service.run() exactly once when checkpoint is valid', async () => {
    const svc = new FakeV3Service({ syncRunId: 'run-v3-ok', recordsProcessed: 200 });
    await runV3IncrementalSync(svc);
    expect(svc.callCount).toBe(1);
  });

  it('returns syncRunId, recordsProcessed and a non-negative integer durationMs', async () => {
    const svc = new FakeV3Service({ syncRunId: 'run-v3-ok', recordsProcessed: 738 });
    const result = await runV3IncrementalSync(svc);
    expect(result.syncRunId).toBe('run-v3-ok');
    expect(result.recordsProcessed).toBe(738);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
    expect(Number.isInteger(result.durationMs)).toBe(true);
  });
});

describe('runV3IncrementalSync — error propagation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetContinuation.mockResolvedValue('2026-10-14T09:04:33.000Z');
  });

  it('propagates errors thrown by service.run()', async () => {
    const svc = new FakeV3Service(new Error('V3 export failed (HTTP 503).'));
    await expect(runV3IncrementalSync(svc)).rejects.toThrow('V3 export failed');
  });

  it('propagates V3SyncInProgressError when a lock is already held', async () => {
    const svc = new FakeV3Service(new V3SyncInProgressError('lock already held'));
    await expect(runV3IncrementalSync(svc)).rejects.toThrow(V3SyncInProgressError);
  });

  it('does not swallow errors — rejected promise escapes the runner', async () => {
    const svc = new FakeV3Service(new Error('unexpected DB failure'));
    let caught: unknown;
    try { await runV3IncrementalSync(svc); } catch (e) { caught = e; }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain('unexpected DB failure');
  });
});

describe('runV3IncrementalSync — no credential/token logging', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Use a realistic ISO-8601 token that contains a full timestamp
    mockGetContinuation.mockResolvedValue('2026-10-14T09:04:33.000Z');
  });

  it('does not log the raw checkpoint token to console.log', async () => {
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const svc = new FakeV3Service();
      await runV3IncrementalSync(svc);
      const allOutput = logSpy.mock.calls.flat().join('\n');
      // Only the date prefix (first 10 chars) may appear — the full token must not
      expect(allOutput).not.toContain('T09:04:33.000Z');
      // Date prefix IS expected (safe to log)
      expect(allOutput).toContain('2026-10-14');
    } finally {
      logSpy.mockRestore();
    }
  });
});
