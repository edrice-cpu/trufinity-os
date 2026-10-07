import { describe, expect, jest, test } from '@jest/globals';
import { QboCdcScheduler } from '../../src/modules/quickbooks/worker/cdc.scheduler';
import { runQboCdcPostCyclePropagation } from '../../src/workers/qbo-cdc.worker';
import type { QboUnifiedMappingResult } from '../../src/modules/quickbooks/mapping/mapping.types';
import type { CustomerIdentityRunResult } from '../../src/modules/identity/customer-identity.types';
import type { QboCdcEntity } from '../../src/modules/quickbooks/types';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() };
const mappingResult = {
  syncRunId: 'mapping-run', recordsProcessed: 3,
  customers: { mapped: 1, deleted: 0, skipped: 0 },
  invoices: { mapped: 1, deleted: 0, skipped: 0 },
  payments: { mapped: 1, deleted: 0, skipped: 0 },
  paymentApplications: { mapped: 1, skipped: 0 }, skippedByReason: {},
};
const identityResult = {
  evaluated: 1, tierAVerifiedMatches: 1, stOnlyUnresolved: 0,
  mergedResolved: 0, skipped: 0, conflicts: 0, issues: [],
};

describe('QBO CDC post-cycle propagation', () => {
  test('runs unified mapping once, then identity refresh once, after a complete cycle', async () => {
    const order: string[] = [];
    const runEntity = jest.fn(async (_entity: QboCdcEntity) => { order.push('cdc'); });
    const mapping = jest.fn(async () => { order.push('mapping'); return mappingResult; });
    const identity = jest.fn(async () => { order.push('identity'); return identityResult; });
    const postCycle = jest.fn(() => runQboCdcPostCyclePropagation({ runMapping: mapping, runIdentityRefresh: identity, logger }));
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, runEntity, afterSuccessfulCycle: postCycle, logger });

    const summary = await scheduler.runCycle();
    expect(summary.failed).toEqual([]);
    expect(postCycle).toHaveBeenCalledTimes(1);
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['cdc', 'cdc', 'cdc', 'cdc', 'mapping', 'identity']);
  });

  test('skips propagation when any CDC entity fails', async () => {
    const runEntity = jest.fn(async (entity: QboCdcEntity) => {
      if (entity === 'Invoice') throw new Error('provider failure');
    });
    const postCycle = jest.fn(async () => undefined);
    const summary = await new QboCdcScheduler({ intervalMs: 900_000, runEntity, afterSuccessfulCycle: postCycle, logger }).runCycle();
    expect(summary.failed).toEqual(['Invoice']);
    expect(postCycle).not.toHaveBeenCalled();
  });

  test('isolates mapping failure and retries propagation on the next successful cycle', async () => {
    const mapping = jest.fn<() => Promise<QboUnifiedMappingResult>>()
      .mockRejectedValueOnce(new Error('mapping failure'))
      .mockResolvedValue(mappingResult);
    const identity = jest.fn<() => Promise<CustomerIdentityRunResult>>().mockResolvedValue(identityResult);
    const postCycle = jest.fn(() => runQboCdcPostCyclePropagation({ runMapping: mapping, runIdentityRefresh: identity, logger }));
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, runEntity: async () => undefined, afterSuccessfulCycle: postCycle, logger });

    await expect(scheduler.runCycle()).resolves.toMatchObject({ failed: [] });
    expect(identity).not.toHaveBeenCalled();
    await expect(scheduler.runCycle()).resolves.toMatchObject({ failed: [] });
    expect(mapping).toHaveBeenCalledTimes(2);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('identity refresh was skipped'));
  });

  test('isolates identity refresh failure after unified mapping has committed', async () => {
    const mapping = jest.fn(async () => mappingResult);
    const identity = jest.fn(async () => { throw new Error('identity failure'); });
    await expect(runQboCdcPostCyclePropagation({ runMapping: mapping, runIdentityRefresh: identity, logger })).resolves.toBeUndefined();
    expect(mapping).toHaveBeenCalledTimes(1);
    expect(identity).toHaveBeenCalledTimes(1);
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('CDC and unified mapping remain committed'));
  });

  test('does not overlap propagation cycles', async () => {
    let release: (() => void) | undefined;
    const postCycle = jest.fn(() => new Promise<void>((resolve) => { release = resolve; }));
    const scheduler = new QboCdcScheduler({ intervalMs: 900_000, runEntity: async () => undefined, afterSuccessfulCycle: postCycle, logger });
    const first = scheduler.runCycle();
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = scheduler.runCycle();
    expect(second).toBe(first);
    expect(postCycle).toHaveBeenCalledTimes(1);
    release?.();
    await first;
  });
});
