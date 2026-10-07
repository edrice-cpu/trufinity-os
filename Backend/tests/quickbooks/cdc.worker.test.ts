import fs from 'node:fs';
import path from 'node:path';
import { beforeEach, describe, expect, jest, test } from '@jest/globals';
import { QboCdcScheduler, validateQboCdcPollInterval } from '../../src/modules/quickbooks/worker/cdc.scheduler';
import { startQboCdcWorker, validateQboCdcWorkerConfig, type QboCdcWorkerDependencies } from '../../src/workers/qbo-cdc.worker';
import type { QboCdcEntity } from '../../src/modules/quickbooks/types';

const quietLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };

describe('QuickBooks CDC scheduler', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  test('executes entities sequentially in order and isolates failures without logging exception details', async () => {
    const order: string[] = [];
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, logger: quietLogger, runEntity: async (entity) => {
      order.push(`${entity}:start`);
      await Promise.resolve();
      order.push(`${entity}:end`);
      if (entity === 'Account') throw new Error('sensitive provider content');
    } });
    const summary = await scheduler.runCycle();
    expect(order).toEqual(['Customer:start', 'Customer:end', 'Account:start', 'Account:end', 'Invoice:start', 'Invoice:end', 'Payment:start', 'Payment:end']);
    expect(summary.failed).toEqual(['Account']);
    expect(summary.succeeded).toEqual(['Customer', 'Invoice', 'Payment']);
    expect(quietLogger.error).toHaveBeenCalledWith('QuickBooks CDC entity failed; entity=Account.');
    expect(quietLogger.error).not.toHaveBeenCalledWith(expect.stringContaining('sensitive provider content'));
    expect(quietLogger.warn).toHaveBeenCalledWith(expect.stringContaining('attempted=4; succeeded=3; failed=1;'));
  });

  test('prevents overlapping cycles and continues successfully in a later cycle', async () => {
    let finishCustomer: (() => void) | undefined;
    let customerRuns = 0;
    const runEntity = jest.fn(async (entity: QboCdcEntity) => {
      if (entity === 'Customer' && customerRuns++ === 0) await new Promise<void>((resolve) => { finishCustomer = resolve; });
      if (entity === 'Invoice' && runEntity.mock.calls.filter(([called]) => called === 'Invoice').length === 1) throw new Error('safe');
    });
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, logger: quietLogger, runEntity });
    const first = scheduler.runCycle();
    expect(scheduler.runCycle()).toBe(first);
    finishCustomer?.();
    await first;
    await scheduler.runCycle();
    expect(runEntity.mock.calls.filter(([entity]) => entity === 'Customer')).toHaveLength(2);
    expect(runEntity.mock.calls.filter(([entity]) => entity === 'Payment')).toHaveLength(2);
  });

  test('starts immediately, waits one interval after completion, and graceful stop prevents another cycle', async () => {
    let releaseWait: (() => void) | undefined;
    let entityCount = 0;
    let waitedMilliseconds: number | undefined;
    let receivedSignal: AbortSignal | undefined;
    const wait = (milliseconds: number, signal: AbortSignal): Promise<void> => {
      waitedMilliseconds = milliseconds;
      receivedSignal = signal;
      return new Promise<void>((resolve) => { releaseWait = resolve; });
    };
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, logger: quietLogger, wait, runEntity: async () => { entityCount += 1; } });
    scheduler.start();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(entityCount).toBe(4);
    expect(waitedMilliseconds).toBe(900_000);
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    const stopping = scheduler.stop();
    releaseWait?.();
    await stopping;
    expect(entityCount).toBe(4);
  });

  test('rejects intervals that could create an API storm', () => {
    expect(validateQboCdcPollInterval(900_000)).toBe(900_000);
    expect(validateQboCdcPollInterval(300_000)).toBe(300_000);
    for (const invalid of [0, -1, 1_000, 86_400_001, 900_000.5]) expect(() => validateQboCdcPollInterval(invalid)).toThrow();
  });
});

describe('QuickBooks CDC worker entrypoint', () => {
  const config = { clientId: 'test-client', clientSecret: 'test-secret', tokenUrl: 'https://oauth.platform.intuit.com/token', apiBaseUrl: 'https://quickbooks.api.intuit.com', pollIntervalMs: 900_000 };

  test('validates required configuration and HTTPS endpoints', () => {
    expect(() => validateQboCdcWorkerConfig(config)).not.toThrow();
    expect(() => validateQboCdcWorkerConfig({ ...config, apiBaseUrl: 'http://localhost' })).toThrow();
    expect(() => validateQboCdcWorkerConfig({ ...config, clientSecret: '' })).toThrow();
  });

  test('checks DB before starting and stops scheduler before closing DB on shutdown', async () => {
    const calls: string[] = [];
    let signalHandler: ((signal: 'SIGTERM' | 'SIGINT') => void) | undefined;
    const dependencies: QboCdcWorkerDependencies = {
      database: { raw: jest.fn(async () => { calls.push('db-check'); }), destroy: jest.fn(async () => { calls.push('db-close'); }) },
      config, runEntity: jest.fn(async () => undefined), logger: quietLogger,
      createScheduler: jest.fn(() => ({ start: () => { calls.push('start'); }, stop: async () => { calls.push('stop'); } })),
      registerShutdown: (handler) => { signalHandler = handler; return () => { calls.push('unregister'); }; },
    };
    const worker = await startQboCdcWorker(dependencies);
    expect(calls).toEqual(['db-check', 'start']);
    signalHandler?.('SIGTERM');
    await worker.shutdown();
    expect(calls).toEqual(['db-check', 'start', 'unregister', 'stop', 'db-close']);
    expect(dependencies.database.raw).toHaveBeenCalledWith('SELECT 1');
  });

  test('is not started by either Express API entrypoint', () => {
    const backendRoot = path.resolve(__dirname, '../..');
    const app = fs.readFileSync(path.join(backendRoot, 'src/app.ts'), 'utf8');
    const server = fs.readFileSync(path.join(backendRoot, 'src/server.ts'), 'utf8');
    expect(app).not.toContain('qbo-cdc.worker');
    expect(server).not.toContain('qbo-cdc.worker');
    expect(server).not.toContain('QboCdcScheduler');
  });

  test('worker contains no disconnect, revoke, or durable-token deletion path', () => {
    const backendRoot = path.resolve(__dirname, '../..');
    const source = fs.readFileSync(path.join(backendRoot, 'src/workers/qbo-cdc.worker.ts'), 'utf8');
    expect(source).not.toMatch(/disconnect|revoke|\.clear\(|\.delete\(/i);
  });
});
