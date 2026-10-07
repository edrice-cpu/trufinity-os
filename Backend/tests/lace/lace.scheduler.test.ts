import { describe, expect, it, jest, beforeEach } from '@jest/globals';

const callAnalysisRun = jest.fn<() => Promise<unknown>>();
const agentPerformanceRun = jest.fn<() => Promise<unknown>>();
const canonicalSync = jest.fn<() => Promise<unknown>>();
const detectRun = jest.fn<() => Promise<unknown>>();
const narrateRun = jest.fn<() => Promise<unknown>>();
const withLock = jest.fn<(db: unknown, key: string, onUnavailable: () => Error, work: () => Promise<unknown>) => Promise<unknown>>();
const loggerInfo = jest.fn();
const loggerError = jest.fn();
const loggerWarn = jest.fn();
const scheduledTasks: string[] = [];

jest.mock('../../src/modules/lace/ingestion/call-analysis.ingestion', () => ({
  laceCallAnalysisIngestionService: { run: callAnalysisRun },
}));
jest.mock('../../src/modules/lace/ingestion/agent-performance.ingestion', () => ({
  laceAgentPerformanceIngestionService: { run: agentPerformanceRun },
}));
jest.mock('../../src/modules/lace/canonical/call-analysis.canonical.service', () => ({
  callAnalysisCanonicalService: { sync: canonicalSync },
}));
jest.mock('../../src/modules/detect/detect.service', () => ({
  detectService: { run: detectRun },
}));
jest.mock('../../src/modules/narrate/narrate.service', () => ({
  narrateService: { run: narrateRun },
}));
jest.mock('../../src/utils/advisory-lock', () => ({
  withAdvisoryLock: withLock,
}));
jest.mock('../../src/utils/logger', () => ({
  logger: { info: loggerInfo, error: loggerError, warn: loggerWarn, debug: jest.fn() },
}));
jest.mock('node-cron', () => ({
  schedule: (expression: string, handler: () => void) => {
    scheduledTasks.push(expression);
    return { handler };
  },
}));

// Each test dynamically imports the scheduler fresh (resetModules), so the
// module-level SCHEDULED_SYNCS array and its captured mock references can't
// leak state between tests - the previous version relied on jest.clearAllMocks()
// alone, which resets call history but not module state.
describe('Lace scheduler', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.resetModules();
    scheduledTasks.length = 0;
    // Default: the advisory lock is free, Detect/Narrate succeed.
    withLock.mockImplementation(async (_db, _key, _onUnavailable, work) => work());
    detectRun.mockResolvedValue({ findings: [] });
    narrateRun.mockResolvedValue({ narrated: 0, failed: 0 });
  });

  it('registers a cron task for both Call Analysis and Agent Performance using the configured expressions', async () => {
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');
    const { env } = await import('../../src/config/env');

    startLaceScheduler();

    expect(scheduledTasks).toEqual([env.LACE_CALL_ANALYSIS_CRON, env.LACE_AGENT_PERFORMANCE_CRON, env.LACE_STUCK_RUN_REAPER_CRON]);
  });

  it('running a scheduled tick calls the ingestion service', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(callAnalysisRun).toHaveBeenCalledTimes(1);
  });

  it('chains canonical sync after a successful call-analysis raw sync (afterSuccess)', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(canonicalSync).toHaveBeenCalledTimes(1);
  });

  it('does not let a canonical-sync failure be mistaken for an ingestion failure', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockRejectedValue(new Error('canonical sync boom'));
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[0].handler()).resolves.toBeUndefined();

    expect(canonicalSync).toHaveBeenCalledTimes(1);
    // The failure must be logged loudly (as a post-sync error), not swallowed silently.
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Post-sync step failed'),
      expect.objectContaining({ error: 'canonical sync boom' }),
    );
    // Detect must not run off a canonical layer that just failed to sync.
    expect(detectRun).not.toHaveBeenCalled();
  });

  it('runs Detect then Narrate, in that order, after a successful canonical sync', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    const { env } = await import('../../src/config/env');
    env.ANTHROPIC_API_KEY = 'test-key';
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(detectRun).toHaveBeenCalledTimes(1);
    expect(narrateRun).toHaveBeenCalledTimes(1);
    const canonicalOrder = canonicalSync.mock.invocationCallOrder[0];
    const detectOrder = detectRun.mock.invocationCallOrder[0];
    const narrateOrder = narrateRun.mock.invocationCallOrder[0];
    expect(canonicalOrder).toBeLessThan(detectOrder);
    expect(detectOrder).toBeLessThan(narrateOrder);
    expect(withLock).toHaveBeenCalledWith(expect.anything(), 'trufinity:detect-narrate-pipeline', expect.any(Function), expect.any(Function));
  });

  it('still runs Detect but skips Narrate (with a warning) when ANTHROPIC_API_KEY is not configured', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    const { env } = await import('../../src/config/env');
    env.ANTHROPIC_API_KEY = '';
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await tasks[0].handler();

    expect(detectRun).toHaveBeenCalledTimes(1);
    expect(narrateRun).not.toHaveBeenCalled();
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('Narrate skipped'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('skips Detect/Narrate quietly when another instance already holds the pipeline lock', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    withLock.mockImplementation(async (_db, _key, onUnavailable) => {
      throw onUnavailable();
    });
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[0].handler()).resolves.toBeUndefined();

    expect(detectRun).not.toHaveBeenCalled();
    expect(narrateRun).not.toHaveBeenCalled();
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('already running on another instance'));
    expect(loggerError).not.toHaveBeenCalled();
  });

  it('logs a Detect failure loudly and does not run Narrate after it', async () => {
    callAnalysisRun.mockResolvedValue({ syncRunId: 'run-1', recordsProcessed: 5, filesProcessed: 1, filesFailed: 0 });
    canonicalSync.mockResolvedValue({ rowsUpserted: 5 });
    detectRun.mockRejectedValue(new Error('detect boom'));
    const { env } = await import('../../src/config/env');
    env.ANTHROPIC_API_KEY = 'test-key';
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[0].handler()).resolves.toBeUndefined();

    expect(narrateRun).not.toHaveBeenCalled();
    expect(loggerError).toHaveBeenCalledWith(
      expect.stringContaining('Post-sync step failed'),
      expect.objectContaining({ error: 'detect boom' }),
    );
  });

  it('swallows a LaceSyncInProgressError from an overlapping run instead of crashing, and logs it at info level', async () => {
    const { LaceSyncInProgressError } = await import('../../src/modules/lace/ingestion/lace-raw.ingestion');
    callAnalysisRun.mockRejectedValue(new LaceSyncInProgressError('call_analysis'));
    const { startLaceScheduler } = await import('../../src/modules/lace/lace.scheduler');

    const tasks = startLaceScheduler() as unknown as { handler: () => Promise<void> }[];
    await expect(tasks[0].handler()).resolves.toBeUndefined();

    expect(callAnalysisRun).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith(expect.stringContaining('skipped: already running'));
    expect(loggerError).not.toHaveBeenCalled();
    // The overlap is expected, not a failure - canonical sync must not run off stale/no data.
    expect(canonicalSync).not.toHaveBeenCalled();
  });
});
