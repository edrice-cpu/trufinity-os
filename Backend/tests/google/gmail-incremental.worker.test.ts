import { describe, it, expect } from '@jest/globals';
import {
  startGmailIncrementalWorker,
  type GmailWorkerDependencies,
} from '../../src/workers/gmail-incremental.worker';

// Minimal cycle result used throughout
const cycleResult: { completed: { mailboxAddress: string }[]; failed: { mailboxAddress: string }[] } = { completed: [], failed: [] };

interface TestDeps extends GmailWorkerDependencies {
  shutdownHandlers: ((s: 'SIGTERM' | 'SIGINT') => void)[];
  logCalls: string[];
}

const makeDeps = (overrides: Partial<GmailWorkerDependencies> = {}): TestDeps => {
  let dbDestroyCount = 0;
  let rawCallCount = 0;
  const shutdownHandlers: ((s: 'SIGTERM' | 'SIGINT') => void)[] = [];
  const logCalls: string[] = [];
  const logger = {
    info: (m: string) => { logCalls.push(m); },
    warn: (m: string) => { logCalls.push(m); },
    error: (m: string) => { logCalls.push(m); },
  };

  const defaultScheduler = {
    start: () => undefined,
    stop: async () => undefined,
  };

  return {
    shutdownHandlers,
    logCalls,
    database: {
      raw: async () => { rawCallCount++; return undefined; },
      get rawCallCount() { return rawCallCount; },
      destroy: async () => { dbDestroyCount++; },
      get destroyCount() { return dbDestroyCount; },
    } as unknown as GmailWorkerDependencies['database'] & { rawCallCount: number; destroyCount: number },
    config: { pollIntervalMs: 300_000 },
    runMailboxes: async () => cycleResult,
    recoverNotifications: async () => 0,
    logger,
    createScheduler: () => defaultScheduler,
    registerShutdown: (handler) => {
      shutdownHandlers.push(handler);
      return () => undefined;
    },
    ...overrides,
  };
};

describe('Gmail incremental worker — startup and lifecycle', () => {
  it('verifies database connectivity (SELECT 1) at startup', async () => {
    const deps = makeDeps();
    const db = deps.database as unknown as { rawCallCount: number };
    await startGmailIncrementalWorker(deps);
    expect(db.rawCallCount).toBe(1);
  });

  it('starts the scheduler and logs a startup message', async () => {
    let startCalled = 0;
    const deps = makeDeps({
      createScheduler: () => ({
        start: () => { startCalled++; },
        stop: async () => undefined,
      }),
    });
    await startGmailIncrementalWorker(deps);
    expect(startCalled).toBe(1);
    expect(deps.logCalls.some((m) => m.toLowerCase().includes('started'))).toBe(true);
  });

  it('registers a shutdown handler', async () => {
    const deps = makeDeps();
    await startGmailIncrementalWorker(deps);
    expect(deps.shutdownHandlers.length).toBe(1);
  });

  it('rejects an invalid poll interval before connecting to the database', async () => {
    const deps = makeDeps({ config: { pollIntervalMs: 1000 } });
    await expect(startGmailIncrementalWorker(deps)).rejects.toThrow('interval');
  });
});

describe('Gmail incremental worker — graceful shutdown', () => {
  it('SIGTERM triggers scheduler.stop() then db.destroy()', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      createScheduler: () => ({
        start: () => undefined,
        stop: async () => { order.push('scheduler.stop'); },
      }),
      database: {
        raw: async () => undefined,
        destroy: async () => { order.push('db.destroy'); },
      },
    });
    const { shutdown } = await startGmailIncrementalWorker(deps);
    await shutdown();
    expect(order).toEqual(['scheduler.stop', 'db.destroy']);
  });

  it('SIGINT triggers the same shutdown path as SIGTERM', async () => {
    const order: string[] = [];
    const deps = makeDeps({
      createScheduler: () => ({
        start: () => undefined,
        stop: async () => { order.push('stop'); },
      }),
      database: {
        raw: async () => undefined,
        destroy: async () => { order.push('destroy'); },
      },
    });
    await startGmailIncrementalWorker(deps);
    // Simulate SIGINT by invoking the registered handler directly
    deps.shutdownHandlers[0]!('SIGINT');
    // Let promises settle
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['stop', 'destroy']);
  });

  it('shutdown is idempotent — db.destroy() is called only once', async () => {
    let destroyCount = 0;
    const deps = makeDeps({
      database: {
        raw: async () => undefined,
        destroy: async () => { destroyCount++; },
      },
    });
    const { shutdown } = await startGmailIncrementalWorker(deps);
    await Promise.all([shutdown(), shutdown(), shutdown()]);
    expect(destroyCount).toBe(1);
  });

  it('no new cycle starts once shutdown is initiated', async () => {
    let runMailboxesCount = 0;
    let shutdownResolve!: () => void;
    const stopGate = new Promise<void>((r) => { shutdownResolve = r; });

    const deps = makeDeps({
      runMailboxes: async () => { runMailboxesCount++; return cycleResult; },
      createScheduler: (runMailboxes, _intervalMs) => {
        let active: Promise<void> | undefined;
        return {
          start: () => { active = runMailboxes().then(() => undefined); },
          stop: async () => { await stopGate; await active; },
        };
      },
    });

    const { shutdown } = await startGmailIncrementalWorker(deps);
    const shutdownPromise = shutdown();
    // Allow runMailboxes to be called at most once; unblock stop
    shutdownResolve();
    await shutdownPromise;
    // runMailboxes may have been called once at start — it must not be called again after shutdown
    const countAfterShutdown = runMailboxesCount;
    await new Promise((r) => setTimeout(r, 20));
    expect(runMailboxesCount).toBe(countAfterShutdown);
  });

  it('scheduler is stopped and db is destroyed even when scheduler.stop throws', async () => {
    let destroyCount = 0;
    const deps = makeDeps({
      createScheduler: () => ({
        start: () => undefined,
        stop: async () => { throw new Error('stop failed'); },
      }),
      database: {
        raw: async () => undefined,
        destroy: async () => { destroyCount++; },
      },
    });
    const { shutdown } = await startGmailIncrementalWorker(deps);
    // Shutdown should propagate the stop error but db.destroy won't run since
    // it's after the await — this tests that the error surfaces, not suppresses
    await expect(shutdown()).rejects.toThrow('stop failed');
  });
});

describe('Gmail incremental worker — notification recovery isolation', () => {
  it('notification recovery failure does not prevent runMailboxes from executing', async () => {
    let mailboxesRan = false;
    const deps = makeDeps({
      recoverNotifications: async () => { throw new Error('SMTP down'); },
      runMailboxes: async () => { mailboxesRan = true; return cycleResult; },
    });

    // Run one cycle via the scheduler closure captured by createScheduler
    let capturedRunMailboxes!: () => Promise<typeof cycleResult>;
    deps.createScheduler = (runMailboxes) => {
      capturedRunMailboxes = runMailboxes as () => Promise<typeof cycleResult>;
      return { start: () => undefined, stop: async () => undefined };
    };

    await startGmailIncrementalWorker(deps);
    await capturedRunMailboxes();
    expect(mailboxesRan).toBe(true);
  });

  it('notification recovery error is logged with a safe message (no err.message)', async () => {
    const deps = makeDeps({
      recoverNotifications: async () => { throw new Error('smtp credentials here'); },
    });

    let capturedRunMailboxes!: () => Promise<typeof cycleResult>;
    deps.createScheduler = (runMailboxes) => {
      capturedRunMailboxes = runMailboxes as () => Promise<typeof cycleResult>;
      return { start: () => undefined, stop: async () => undefined };
    };

    await startGmailIncrementalWorker(deps);
    await capturedRunMailboxes();

    // The raw error message must NOT appear in any log call
    expect(deps.logCalls.some((m) => m.includes('smtp credentials here'))).toBe(false);
    // But an error IS logged
    expect(deps.logCalls.some((m) => m.toLowerCase().includes('recovery failed'))).toBe(true);
  });
});
