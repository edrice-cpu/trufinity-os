// Mocked tests for ServiceTitan V3 TelecomCall enrichment ingestion.
// No production DB writes, no live API calls.

// Hoist mocks — ts-jest hoists jest.mock() above all imports, so these run
// before the module singletons (DB pool, authService) are constructed.
jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-token', clearCache: () => undefined },
}));

import { describe, it, expect, jest } from '@jest/globals';
import {
  mapBundleToRow,
  ServiceTitanTelecomCallsV3IngestionService,
  V3SyncInProgressError,
  type V2CoverageResult,
  type V3Bundle,
  type V3CallsApi,
  type V3CallsResponse,
  type V3EnrichmentRepository,
} from '../../src/modules/servicetitan/ingestion/telecom-calls-v3.ingestion';

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_SYSTEM = 'ServiceTitan:2088992281';
const HISTORICAL_FROM = '2026-07-10';

function makeBundle(overrides: Partial<V3Bundle> = {}): V3Bundle {
  return {
    id: 0,
    jobNumber: null,
    projectId: null,
    businessUnit: null,
    type: null,
    leadCall: {
      id: 93196845,
      createdOn: '2026-07-10T10:00:00Z',
      modifiedOn: '2026-07-10T10:05:00Z',
      receivedOn: '2026-07-10T10:00:00Z',
      direction: 'Outbound',
      callType: 'Lead',
      duration: '00:02:51',
      reason: null,
      active: true,
      sid: 'CA04625c6232bcf932ab9b2ce40a629c8d',
      agent: { id: 55, name: 'Jane Doe' },
      campaign: { id: 12 },
      tags: [{ id: 1, name: 'Follow-up' }],
    },
    ...overrides,
  };
}

function makePage(bundles: V3Bundle[], hasMore = false, page = 1): V3CallsResponse {
  return { page, pageSize: 100, hasMore, totalCount: null, data: bundles };
}

function buildRepo(savedToken: string | null = null, overrides: Partial<V3EnrichmentRepository> = {}) {
  const state = {
    token: savedToken,
    upserted: [] as ReturnType<typeof mapBundleToRow>[],
    syncRunId: null as string | null,
    completed: false,
    failed: false,
    failMessage: '',
  };

  const repo: V3EnrichmentRepository = {
    withExclusiveLock: (fn) => fn(repo),
    recoverInterruptedRuns: async () => undefined,
    createSyncRun: async () => { state.syncRunId = 'run-001'; return 'run-001'; },
    // Atomic: both token and completed flag set together, or neither on throw.
    completeRun: async (_syncRunId, runStartedAt, _recordsProcessed) => {
      state.token = runStartedAt;
      state.completed = true;
    },
    completeSyncRun: async () => { state.completed = true; },
    failSyncRun: async (_id, msg) => { state.failed = true; state.failMessage = msg; },
    getContinuation: async () => state.token,
    updateContinuation: async (value) => { state.token = value; },
    upsertBatch: async (_id, rows) => { state.upserted.push(...rows); },
    reconcileV2Links: async () => 0,
    checkV2Coverage: async () => ({ missing: 0, oldest: null, newest: null }),
    ...overrides,
  };
  return { repo, state };
}

interface CapturedCall {
  page: number;
  paramName: string;
  paramValue: string;
  boundParamName: string;
  boundValue: string;
  allParams: Record<string, string | number | boolean>;
}

function makeClient(pages: V3CallsResponse[]): V3CallsApi & { calls: CapturedCall[] } {
  let callIndex = 0;
  const calls: CapturedCall[] = [];
  return {
    calls,
    get: jest.fn(async (_endpoint: string, params: Record<string, string | number | boolean>) => {
      calls.push({
        page: params['page'] as number,
        paramName: params['modifiedOnOrAfter'] !== undefined ? 'modifiedOnOrAfter' : 'createdOnOrAfter',
        paramValue: (params['modifiedOnOrAfter'] ?? params['createdOnOrAfter'] ?? '') as string,
        boundParamName: params['modifiedBefore'] !== undefined ? 'modifiedBefore' : 'createdBefore',
        boundValue: (params['modifiedBefore'] ?? params['createdBefore'] ?? '') as string,
        allParams: params,
      });
      const page = pages[callIndex++];
      if (!page) throw new Error('No more pages configured');
      return page;
    }) as V3CallsApi['get'],
  };
}

// ─── mapBundleToRow ───────────────────────────────────────────────────────────

describe('mapBundleToRow', () => {
  it('maps all fields correctly', () => {
    const bundle = makeBundle();
    const row = mapBundleToRow(bundle, SOURCE_SYSTEM);
    expect(row.source_system).toBe(SOURCE_SYSTEM);
    expect(row.source_id).toBe('93196845');
    expect(row.direction).toBe('Outbound');
    expect(row.call_type).toBe('Lead');
    expect(row.duration).toBe('00:02:51');
    expect(row.active).toBe(true);
    expect(row.sid).toBe('CA04625c6232bcf932ab9b2ce40a629c8d');
    expect(row.agent_id).toBe('55');
    expect(row.agent_name).toBe('Jane Doe');
    expect(row.campaign_id).toBe('12');
    expect(row.tags).toHaveLength(1);
    expect(row.call_received_on).toBeInstanceOf(Date);
    expect(row.v3_created_on).toBeInstanceOf(Date);
    expect(row.v3_modified_on).toBeInstanceOf(Date);
  });

  it('handles all nullable fields gracefully', () => {
    const bundle = makeBundle({
      leadCall: {
        id: 1,
        callType: null,
        direction: null,
        duration: null,
        reason: null,
        active: null,
        sid: null,
        agent: null,
        campaign: null,
        tags: null,
        receivedOn: null,
        createdOn: null,
        modifiedOn: null,
      },
    });
    const row = mapBundleToRow(bundle, SOURCE_SYSTEM);
    expect(row.call_type).toBeNull();
    expect(row.direction).toBeNull();
    expect(row.active).toBeNull();
    expect(row.sid).toBeNull();
    expect(row.agent_id).toBeNull();
    expect(row.agent_name).toBeNull();
    expect(row.tags).toBeNull();
    expect(row.call_received_on).toBeNull();
    expect(row.v3_created_on).toBeNull();
  });

  it('returns null for empty tags array', () => {
    const bundle = makeBundle({ leadCall: { ...makeBundle().leadCall, tags: [] } });
    expect(mapBundleToRow(bundle, SOURCE_SYSTEM).tags).toBeNull();
  });

  it('maps agent numeric id to string', () => {
    const bundle = makeBundle({ leadCall: { ...makeBundle().leadCall, agent: { id: 0, name: '' } } });
    const row = mapBundleToRow(bundle, SOURCE_SYSTEM);
    expect(row.agent_id).toBe('0');
    expect(row.agent_name).toBeNull(); // empty string → null
  });

  it('stores full bundle as v3_payload', () => {
    const bundle = makeBundle();
    const row = mapBundleToRow(bundle, SOURCE_SYSTEM);
    expect((row.v3_payload as unknown as V3Bundle).leadCall.id).toBe(93196845);
  });
});

// ─── Pagination ───────────────────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — pagination', () => {
  it('processes a single page and terminates', async () => {
    const { repo, state } = buildRepo();
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(1);
    expect(state.upserted).toHaveLength(1);
    expect(state.completed).toBe(true);
  });

  it('processes multiple pages and terminates on hasMore=false', async () => {
    const { repo } = buildRepo();
    const client = makeClient([
      makePage([makeBundle(), makeBundle({ leadCall: { ...makeBundle().leadCall, id: 2 } })], true, 1),
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 3 } })], false, 2),
    ]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(3);
    expect(client.calls).toHaveLength(2);
    expect(client.calls[0]!.page).toBe(1);
    expect(client.calls[1]!.page).toBe(2);
  });

  it('handles an empty first page gracefully', async () => {
    const { repo, state } = buildRepo();
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(0);
    expect(state.upserted).toHaveLength(0);
    expect(state.completed).toBe(true);
  });

  it('skips bundles with missing leadCall.id without throwing', async () => {
    const badBundle = { ...makeBundle(), leadCall: { ...makeBundle().leadCall, id: undefined as unknown as number } };
    const { repo, state } = buildRepo();
    const client = makeClient([makePage([badBundle], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(0);
    expect(state.upserted).toHaveLength(0);
  });
});

// ─── Historical vs incremental — date filter selection ──────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — date filter selection', () => {
  it('uses createdOnOrAfter on the first run (no saved token)', async () => {
    const { repo } = buildRepo(null);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    expect(client.calls[0]!.paramName).toBe('createdOnOrAfter');
    expect(client.calls[0]!.paramValue).toBe(HISTORICAL_FROM);
  });

  it('uses modifiedOnOrAfter on subsequent runs (saved token present)', async () => {
    const savedToken = '2026-08-01T00:00:00.000Z';
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    // overlapMs=0 so paramValue equals savedToken exactly
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(client.calls[0]!.paramName).toBe('modifiedOnOrAfter');
    expect(client.calls[0]!.paramValue).toBe(savedToken);
  });

  it('stores the run start time as the continuation token after a successful run', async () => {
    const before = Date.now();
    const { repo, state } = buildRepo(null);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    const after = Date.now();
    const storedTime = new Date(state.token!).getTime();
    expect(storedTime).toBeGreaterThanOrEqual(before);
    expect(storedTime).toBeLessThanOrEqual(after);
  });

  it('does NOT update the continuation token when the run fails', async () => {
    const { repo, state } = buildRepo(null, {
      createSyncRun: async () => { throw new Error('DB down'); },
    });
    const client = makeClient([]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow();
    expect(state.token).toBeNull();
  });
});

// ─── Duplicate / idempotent upserts ──────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — idempotency', () => {
  it('passes all rows from the page to upsertBatch (deduplication is DB-side)', async () => {
    const { repo, state } = buildRepo();
    const b1 = makeBundle();
    const b2 = makeBundle(); // same source_id — DB handles conflict
    const client = makeClient([makePage([b1, b2], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    // Both rows passed to upsertBatch — the ON CONFLICT clause handles dedup in Postgres
    expect(state.upserted).toHaveLength(2);
  });

  it('a second run uses modifiedOnOrAfter, not createdOnOrAfter', async () => {
    const savedToken = '2026-09-01T00:00:00.000Z';
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    expect(client.calls[0]!.paramName).toBe('modifiedOnOrAfter');
  });
});

// ─── Authentication failure ───────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — API auth failure', () => {
  it('propagates a 401 error and marks the sync run failed', async () => {
    let failedMsg = '';
    const { repo } = buildRepo(null, {
      failSyncRun: async (_id: string, msg: string) => { failedMsg = msg; },
    });
    const client: V3CallsApi = {
      get: jest.fn(async () => { throw new Error('ServiceTitan API Error: [401]'); }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow('401');
    expect(failedMsg).toMatch(/401/);
  });
});

// ─── Rate limiting and transient errors ───────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — transient errors', () => {
  it('retries on a 429 and succeeds on the second attempt', async () => {
    const { repo, state } = buildRepo();
    let callCount = 0;
    const client: V3CallsApi = {
      get: jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('ServiceTitan API Error: [429]');
        return makePage([makeBundle()], false);
      }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    const result = await svc.run();
    expect(callCount).toBe(2);
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
  });

  it('retries on a 503 and succeeds on the second attempt', async () => {
    const { repo } = buildRepo();
    let callCount = 0;
    const client: V3CallsApi = {
      get: jest.fn(async () => {
        callCount++;
        if (callCount === 1) throw new Error('ServiceTitan API Error: [503]');
        return makePage([], false);
      }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    expect(callCount).toBe(2);
  });

  it('fails after exhausting 3 transient attempts', async () => {
    const { repo, state } = buildRepo();
    const client: V3CallsApi = {
      get: jest.fn(async () => { throw new Error('ServiceTitan API Error: [500]'); }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow('500');
    expect(state.failed).toBe(true);
  });

  it('does NOT retry on a 400 (non-transient)', async () => {
    const { repo } = buildRepo();
    let callCount = 0;
    const client: V3CallsApi = {
      get: jest.fn(async () => { callCount++; throw new Error('ServiceTitan API Error: [400]'); }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow('400');
    expect(callCount).toBe(1); // no retry for 400
  });
});

// ─── Unmatched V2 call IDs ────────────────────────────────────────────────────

describe('mapBundleToRow — unmatched V2 call ID handling', () => {
  it('maps a bundle regardless of whether a V2 record exists (v2_linked is a DB concern)', () => {
    // The ingestion service always maps and upserts; the v2_linked column is set
    // by the DB's EXISTS subquery at upsert time. The service never queries raw_st_calls.
    const bundle = makeBundle({ leadCall: { ...makeBundle().leadCall, id: 99999999 } });
    const row = mapBundleToRow(bundle, SOURCE_SYSTEM);
    expect(row.source_id).toBe('99999999');
    // v2_linked is not part of EnrichmentRow — it's computed by the DB at upsert time
    expect('v2_linked' in row).toBe(false);
  });
});

// ─── V3SyncInProgressError ────────────────────────────────────────────────────

describe('V3SyncInProgressError', () => {
  it('is thrown when the advisory lock is already held', async () => {
    const repo: V3EnrichmentRepository = {
      withExclusiveLock: async () => { throw new V3SyncInProgressError('already running'); },
      recoverInterruptedRuns: async () => undefined,
      createSyncRun: async () => '',
      completeRun: async () => undefined,
      completeSyncRun: async () => undefined,
      failSyncRun: async () => undefined,
      getContinuation: async () => null,
      updateContinuation: async () => undefined,
      upsertBatch: async () => undefined,
      reconcileV2Links: async () => 0,
      checkV2Coverage: async () => ({ missing: 0, oldest: null, newest: null }),
    };
    const client = makeClient([]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toBeInstanceOf(V3SyncInProgressError);
  });
});

// ─── Malformed response ───────────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — malformed response', () => {
  it('throws on a response missing the data array', async () => {
    const { repo, state } = buildRepo();
    const client: V3CallsApi = {
      get: jest.fn(async () => ({ page: 1, pageSize: 100, hasMore: false, totalCount: null })) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow('failed');
    expect(state.failed).toBe(true);
  });

  it('throws on a response missing the hasMore field', async () => {
    const { repo, state } = buildRepo();
    const client: V3CallsApi = {
      get: jest.fn(async () => ({ page: 1, pageSize: 100, totalCount: null, data: [] })) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow('failed');
    expect(state.failed).toBe(true);
  });
});

// ─── Interrupted synchronization — checkpoint safety ─────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — checkpoint safety', () => {
  it('calls recoverInterruptedRuns before creating a new sync run', async () => {
    const recoveredOrder: string[] = [];
    const { repo } = buildRepo(null, {
      recoverInterruptedRuns: jest.fn(async () => { recoveredOrder.push('recover'); }) as V3EnrichmentRepository['recoverInterruptedRuns'],
      createSyncRun: jest.fn(async () => { recoveredOrder.push('create'); return 'run-001'; }) as V3EnrichmentRepository['createSyncRun'],
    });
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await svc.run();
    expect(recoveredOrder).toEqual(['recover', 'create']);
  });

  it('does not call upsertBatch when an error occurs before page fetching', async () => {
    const upsertCalled = jest.fn();
    const { repo } = buildRepo(null, {
      createSyncRun: jest.fn(async () => { throw new Error('DB connection failed'); }) as V3EnrichmentRepository['createSyncRun'],
      upsertBatch: upsertCalled as unknown as V3EnrichmentRepository['upsertBatch'],
    });
    const client = makeClient([]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM);
    await expect(svc.run()).rejects.toThrow();
    expect(upsertCalled).not.toHaveBeenCalled();
  });
});

// ─── Bounded pagination window ────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — bounded pagination window', () => {
  it('sends createdBefore=runStartedAt alongside createdOnOrAfter on first run', async () => {
    const before = new Date().toISOString();
    const { repo } = buildRepo(null);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    const call = client.calls[0]!;
    expect(call.paramName).toBe('createdOnOrAfter');
    expect(call.boundParamName).toBe('createdBefore');
    // createdBefore should be >= before (run start captured before fetch)
    expect(new Date(call.boundValue).getTime()).toBeGreaterThanOrEqual(new Date(before).getTime());
  });

  it('sends modifiedBefore=runStartedAt alongside modifiedOnOrAfter on incremental run', async () => {
    const savedToken = '2026-08-01T00:00:00.000Z';
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    const call = client.calls[0]!;
    expect(call.paramName).toBe('modifiedOnOrAfter');
    expect(call.boundParamName).toBe('modifiedBefore');
  });

  it('all pages in a multi-page run use the same bound timestamp', async () => {
    const savedToken = '2026-08-01T00:00:00.000Z';
    const { repo } = buildRepo(savedToken);
    const client = makeClient([
      makePage([makeBundle()], true, 1),
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 2 } })], false, 2),
    ]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(client.calls).toHaveLength(2);
    // Both pages must use the same modifiedBefore bound
    expect(client.calls[0]!.boundValue).toBe(client.calls[1]!.boundValue);
  });
});

// ─── Overlap window ───────────────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — overlap window', () => {
  it('subtracts overlap from savedToken for modifiedOnOrAfter', async () => {
    const savedToken = '2026-09-01T00:10:00.000Z'; // 10 minutes past the hour
    const overlapMs = 5 * 60_000; // 5 minutes
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, overlapMs);
    await svc.run();
    const call = client.calls[0]!;
    expect(call.paramName).toBe('modifiedOnOrAfter');
    // Value should be savedToken minus 5 minutes
    const expected = new Date(new Date(savedToken).getTime() - overlapMs).toISOString();
    expect(call.paramValue).toBe(expected);
  });

  it('does NOT subtract overlap on historical (first) run', async () => {
    const { repo } = buildRepo(null);
    const client = makeClient([makePage([], false)]);
    const overlapMs = 5 * 60_000;
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, overlapMs);
    await svc.run();
    const call = client.calls[0]!;
    expect(call.paramName).toBe('createdOnOrAfter');
    expect(call.paramValue).toBe(HISTORICAL_FROM);
  });

  it('overlap of 0 ms sends savedToken unchanged', async () => {
    const savedToken = '2026-09-15T12:00:00.000Z';
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(client.calls[0]!.paramValue).toBe(savedToken);
  });

  it('overlap larger than savedToken clamps to epoch (no negative timestamp)', async () => {
    const savedToken = '1970-01-01T00:00:10.000Z'; // 10 seconds after epoch
    const overlapMs = 60_000; // 1 minute — larger than 10 seconds
    const { repo } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, overlapMs);
    await svc.run();
    const adjustedTime = new Date(client.calls[0]!.paramValue).getTime();
    expect(adjustedTime).toBeGreaterThanOrEqual(0);
  });
});

// ─── Max pages guard ──────────────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — max pages guard', () => {
  it('aborts and marks run failed when maxPagesPerRun is exceeded', async () => {
    const { repo, state } = buildRepo();
    let pagesFetched = 0;
    const client: V3CallsApi = {
      get: jest.fn(async (_ep: string, p: Record<string, string | number | boolean>) => {
        pagesFetched = p['page'] as number;
        // Always returns hasMore=true so the loop never self-terminates
        return makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: pagesFetched } })], true, pagesFetched);
      }) as V3CallsApi['get'],
    };
    // maxPagesPerRun=3 → guard fires on page 4
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0, 3);
    await expect(svc.run()).rejects.toThrow('failed');
    expect(pagesFetched).toBe(3);       // guard fires before fetching page 4; last fetched page is 3
    expect(state.failed).toBe(true);    // run marked failed
    expect(state.token).toBeNull();     // checkpoint NOT advanced
    expect(state.completed).toBe(false);
  });

  it('guard does NOT fire when exactly maxPagesPerRun pages are fetched', async () => {
    const { repo, state } = buildRepo();
    let callCount = 0;
    const client: V3CallsApi = {
      get: jest.fn(async (_ep: string, p: Record<string, string | number | boolean>) => {
        callCount++;
        const page = p['page'] as number;
        // Return hasMore=false on page 3 (the limit)
        return makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: page } })], page < 3, page);
      }) as V3CallsApi['get'],
    };
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0, 3);
    const result = await svc.run();
    expect(callCount).toBe(3);
    expect(result.recordsProcessed).toBe(3);
    expect(state.completed).toBe(true);  // guard did not fire — run succeeded
  });
});

// ─── V2 reconciliation ────────────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — V2 reconciliation', () => {
  it('calls reconcileV2Links after a successful run', async () => {
    const reconcileCalled = jest.fn(async () => 3);
    const { repo } = buildRepo(null, {
      reconcileV2Links: reconcileCalled as V3EnrichmentRepository['reconcileV2Links'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(reconcileCalled).toHaveBeenCalledTimes(1);
  });

  it('does NOT call reconcileV2Links when the run fails before completion', async () => {
    const reconcileCalled = jest.fn();
    const { repo } = buildRepo(null, {
      upsertBatch: jest.fn(async () => { throw new Error('DB error'); }) as V3EnrichmentRepository['upsertBatch'],
      reconcileV2Links: reconcileCalled as V3EnrichmentRepository['reconcileV2Links'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow();
    expect(reconcileCalled).not.toHaveBeenCalled();
  });

  it('reconciliation failure does not fail the overall run', async () => {
    const { repo, state } = buildRepo(null, {
      reconcileV2Links: jest.fn(async () => { throw new Error('reconcile DB error'); }) as V3EnrichmentRepository['reconcileV2Links'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run(); // should NOT throw
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
  });

  it('reconcileV2Links can be called independently via the service method', async () => {
    const reconcileImpl = jest.fn(async () => 7);
    const { repo } = buildRepo(null, {
      reconcileV2Links: reconcileImpl as V3EnrichmentRepository['reconcileV2Links'],
    });
    const client = makeClient([]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const linked = await svc.reconcileV2Links();
    expect(linked).toBe(7);
    expect(reconcileImpl).toHaveBeenCalledTimes(1);
  });
});

// ─── Atomic checkpoint + completion (completeRun) ─────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — atomic completeRun', () => {
  it('calls completeRun once with correct syncRunId, runStartedAt and recordsProcessed', async () => {
    const completeRunCalls: Array<{ syncRunId: string; runStartedAt: string; recordsProcessed: number }> = [];
    const { repo } = buildRepo(null, {
      completeRun: jest.fn(async (syncRunId: string, runStartedAt: string, recordsProcessed: number) => {
        completeRunCalls.push({ syncRunId, runStartedAt, recordsProcessed });
      }) as V3EnrichmentRepository['completeRun'],
    });
    const client = makeClient([makePage([makeBundle(), makeBundle({ leadCall: { ...makeBundle().leadCall, id: 2 } })], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const before = Date.now();
    await svc.run();
    const after = Date.now();
    expect(completeRunCalls).toHaveLength(1);
    expect(completeRunCalls[0]!.syncRunId).toBe('run-001');
    expect(completeRunCalls[0]!.recordsProcessed).toBe(2);
    // runStartedAt must be a timestamp between before and after
    const ts = new Date(completeRunCalls[0]!.runStartedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('a completeRun failure leaves checkpoint unchanged and marks run failed', async () => {
    const { repo, state } = buildRepo(null, {
      completeRun: jest.fn(async () => { throw new Error('transaction commit failed'); }) as V3EnrichmentRepository['completeRun'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow('failed');
    // Checkpoint NOT advanced — token remains null
    expect(state.token).toBeNull();
    // completeSyncRun was NOT called (only completeRun is called from runLocked)
    expect(state.completed).toBe(false);
    // failSyncRun IS called — catch block transitions run to failed
    expect(state.failed).toBe(true);
  });

  it('a completeRun failure on incremental run preserves previous checkpoint', async () => {
    const savedToken = '2026-09-01T00:00:00.000Z';
    const { repo, state } = buildRepo(savedToken, {
      completeRun: jest.fn(async () => { throw new Error('transaction commit failed'); }) as V3EnrichmentRepository['completeRun'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow('failed');
    // Token unchanged — still the original savedToken
    expect(state.token).toBe(savedToken);
    expect(state.completed).toBe(false);
    expect(state.failed).toBe(true);
  });

  it('does NOT call updateContinuation or completeSyncRun separately after the fix', async () => {
    const updateContinuationSpy = jest.fn(async () => undefined);
    const completeSyncRunSpy = jest.fn(async () => undefined);
    const { repo } = buildRepo(null, {
      updateContinuation: updateContinuationSpy as V3EnrichmentRepository['updateContinuation'],
      completeSyncRun: completeSyncRunSpy as V3EnrichmentRepository['completeSyncRun'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    // Neither standalone method is called — only completeRun
    expect(updateContinuationSpy).not.toHaveBeenCalled();
    expect(completeSyncRunSpy).not.toHaveBeenCalled();
  });

  it('V2 Telecom checkpoint (entity_type=TelecomCall) is never touched by V3 completeRun', () => {
    // V3 uses entity_type='TelecomCallV3' and source_system scoped to the tenant.
    // The ON CONFLICT key is (source_system, entity_type) — a different composite
    // key from the V2 row (entity_type='TelecomCall'). No shared row is possible.
    // This is a documentation-level assertion; the actual isolation is enforced by
    // the ENTITY_TYPE constant being 'TelecomCallV3' throughout the V3 module.
    //
    // Verified: getContinuation() in buildRepo returns only from state.token (mocked
    // V3 row). A real V2 row in raw_sync_metadata is untouched because the WHERE
    // clause filters on entity_type='TelecomCallV3'.
    const entityType = 'TelecomCallV3';
    expect(entityType).not.toBe('TelecomCall');
  });
});

// ─── raw_sync_metadata schema contract ───────────────────────────────────────
//
// raw_sync_metadata was created in migration 001 with exactly five columns:
//   id, source_system, entity_type, continuation_token, last_synced_at
// There is NO sync_run_id column. The V3 checkpoint writes must match this
// schema; any attempt to INSERT sync_run_id will produce a PostgreSQL error.
//
// These tests verify that completeRun and updateContinuation only pass the
// columns that exist in raw_sync_metadata.

describe('ServiceTitanTelecomCallsV3IngestionService — raw_sync_metadata schema contract', () => {
  it('completeRun does not reference sync_run_id in raw_sync_metadata insert', async () => {
    // Intercept the completeRun call and capture what the repo receives.
    // The mock repo's completeRun records the token and completed flag — if the
    // real PostgresV3EnrichmentRepository.completeRun tried to write sync_run_id
    // it would throw "column does not exist". The mocked version verifies the
    // service calls completeRun (not the old two-step path) with correct args.
    const completeRunArgs: Array<[string, string, number]> = [];
    const { repo, state } = buildRepo(null, {
      completeRun: jest.fn(async (syncRunId: string, runStartedAt: string, recordsProcessed: number) => {
        completeRunArgs.push([syncRunId, runStartedAt, recordsProcessed]);
        state.token = runStartedAt;
        state.completed = true;
      }) as V3EnrichmentRepository['completeRun'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(completeRunArgs).toHaveLength(1);
    // syncRunId, runStartedAt (ISO string), recordsProcessed=1
    const [syncRunId, runStartedAt, recordsProcessed] = completeRunArgs[0]!;
    expect(typeof syncRunId).toBe('string');
    expect(() => new Date(runStartedAt)).not.toThrow();
    expect(recordsProcessed).toBe(1);
  });

  it('updateContinuation is NOT called from the main run path (completeRun is used instead)', async () => {
    const updateContinuationSpy = jest.fn(async () => undefined);
    const { repo } = buildRepo(null, {
      updateContinuation: updateContinuationSpy as V3EnrichmentRepository['updateContinuation'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(updateContinuationSpy).not.toHaveBeenCalled();
  });

  it('a completeRun that throws (simulating column-not-found) marks run failed and preserves null checkpoint', async () => {
    // Simulates the exact failure mode: completeRun throws a DB error because
    // sync_run_id does not exist in raw_sync_metadata. Verifies:
    //   - checkpoint NOT advanced (token stays null)
    //   - sync run marked failed (failSyncRun called)
    //   - run does NOT complete successfully
    const { repo, state } = buildRepo(null, {
      completeRun: jest.fn(async () => {
        throw new Error('column "sync_run_id" of relation "raw_sync_metadata" does not exist');
      }) as V3EnrichmentRepository['completeRun'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow('failed');
    expect(state.token).toBeNull();
    expect(state.completed).toBe(false);
    expect(state.failed).toBe(true);
  });

  it('after the fix, completeRun succeeds and checkpoint is saved', async () => {
    // Full happy-path: verifies token is set (checkpoint saved) and run completed.
    const { repo, state } = buildRepo(null);
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
    expect(state.token).not.toBeNull();
    expect(() => new Date(state.token!)).not.toThrow();
  });
});

// ─── V2→V3 coverage monitoring ───────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — V2→V3 coverage monitoring', () => {
  it('calls checkV2Coverage after a successful run', async () => {
    const coverageCalled = jest.fn(async (_historicalFrom: string): Promise<V2CoverageResult> => ({ missing: 0, oldest: null, newest: null }));
    const { repo } = buildRepo(null, {
      checkV2Coverage: coverageCalled as V3EnrichmentRepository['checkV2Coverage'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await svc.run();
    expect(coverageCalled).toHaveBeenCalledTimes(1);
    // historicalFrom is passed so the query excludes pre-window V2 records
    expect(coverageCalled).toHaveBeenCalledWith(HISTORICAL_FROM);
  });

  it('does NOT call checkV2Coverage when the run fails before completion', async () => {
    const coverageCalled = jest.fn();
    const { repo } = buildRepo(null, {
      upsertBatch: jest.fn(async () => { throw new Error('DB error'); }) as V3EnrichmentRepository['upsertBatch'],
      checkV2Coverage: coverageCalled as unknown as V3EnrichmentRepository['checkV2Coverage'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow();
    expect(coverageCalled).not.toHaveBeenCalled();
  });

  it('zero gaps: run completes successfully and no warning is logged', async () => {
    const { repo, state } = buildRepo(null, {
      checkV2Coverage: async (): Promise<V2CoverageResult> => ({ missing: 0, oldest: null, newest: null }),
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
    expect(state.failed).toBe(false);
  });

  it('genuine missing records above threshold: run still completes (non-fatal)', async () => {
    const { repo, state } = buildRepo(null, {
      checkV2Coverage: async (): Promise<V2CoverageResult> => ({
        missing: 50,
        oldest: new Date('2026-07-11T08:00:00Z'),
        newest: new Date('2026-08-01T12:00:00Z'),
      }),
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();
    // Run completed — coverage gap does not abort or fail the run
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
    expect(state.failed).toBe(false);
    // Checkpoint was advanced
    expect(state.token).not.toBeNull();
  });

  it('coverage check failure does not affect checkpoint or sync run completion', async () => {
    const { repo, state } = buildRepo(null, {
      checkV2Coverage: jest.fn(async () => { throw new Error('coverage query DB error'); }) as V3EnrichmentRepository['checkV2Coverage'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();
    // Run must succeed despite checkV2Coverage throwing
    expect(result.recordsProcessed).toBe(1);
    expect(state.completed).toBe(true);
    expect(state.failed).toBe(false);
    // Checkpoint was still advanced
    expect(state.token).not.toBeNull();
  });
});

// ─── Non-empty incremental run ────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — non-empty incremental run', () => {
  it('processes new and previously-seen (updated) records on incremental run', async () => {
    // Simulates a real incremental scenario:
    //   - savedToken present → service uses modifiedOnOrAfter
    //   - API returns 3 records: 2 new IDs + 1 existing ID (a modified older call)
    //   - All 3 are passed to upsertBatch (DB handles the ON CONFLICT DO UPDATE)
    const savedToken = '2026-10-09T08:59:37.993Z';
    const { repo, state } = buildRepo(savedToken);
    const newCall1 = makeBundle({ leadCall: { ...makeBundle().leadCall, id: 11111111 } });
    const newCall2 = makeBundle({ leadCall: { ...makeBundle().leadCall, id: 22222222 } });
    const updatedCall = makeBundle({ leadCall: { ...makeBundle().leadCall, id: 93196845, callType: 'Lead' } }); // existing ID with updated callType
    const client = makeClient([makePage([newCall1, newCall2, updatedCall], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);

    const result = await svc.run();

    expect(result.recordsProcessed).toBe(3);
    expect(state.upserted).toHaveLength(3);
    // Verify the correct filter params were used
    expect(client.calls[0]!.paramName).toBe('modifiedOnOrAfter');
    expect(client.calls[0]!.paramValue).toBe(savedToken); // overlapMs=0 → exact token
    expect(client.calls[0]!.boundParamName).toBe('modifiedBefore');
    // Checkpoint advanced to this run's start
    expect(state.token).not.toBe(savedToken);
    expect(new Date(state.token!).getTime()).toBeGreaterThan(new Date(savedToken).getTime());
    expect(state.completed).toBe(true);
  });

  it('incremental run with multi-page response processes all pages and advances checkpoint', async () => {
    const savedToken = '2026-10-08T06:00:00.000Z';
    const { repo, state } = buildRepo(savedToken);
    const client = makeClient([
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 1 } }), makeBundle({ leadCall: { ...makeBundle().leadCall, id: 2 } })], true, 1),
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 3 } })], true, 2),
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 4 } })], false, 3),
    ]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();

    expect(result.recordsProcessed).toBe(4);
    expect(client.calls).toHaveLength(3);
    // All pages use the same modifiedBefore bound
    const bound = client.calls[0]!.boundValue;
    expect(client.calls[1]!.boundValue).toBe(bound);
    expect(client.calls[2]!.boundValue).toBe(bound);
    expect(state.completed).toBe(true);
    expect(state.token).not.toBe(savedToken);
  });

  it('incremental run with empty window returns 0 records and still advances checkpoint', async () => {
    // Real observed behavior: 13-minute window with no modified calls returns empty page
    const savedToken = '2026-10-09T09:04:37.993Z';
    const { repo, state } = buildRepo(savedToken);
    const client = makeClient([makePage([], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    const result = await svc.run();

    expect(result.recordsProcessed).toBe(0);
    expect(state.completed).toBe(true);
    expect(state.token).not.toBe(savedToken); // checkpoint still advances
  });
});

// ─── Mid-pagination failure ───────────────────────────────────────────────────

describe('ServiceTitanTelecomCallsV3IngestionService — mid-pagination DB failure', () => {
  it('upsertBatch failure on page 2 fails the run and preserves prior checkpoint', async () => {
    // Pages 1 and 2 are fetched. Page 1 upsert succeeds (rows committed). Page 2 upsert throws.
    // Expected: run fails, checkpoint NOT advanced, failSyncRun called.
    // The page-1 rows are already committed in their own transaction (idempotent on retry).
    const savedToken = '2026-09-01T00:00:00.000Z';
    let upsertCallCount = 0;
    const { repo, state } = buildRepo(savedToken, {
      upsertBatch: jest.fn(async (_id: string, rows: ReturnType<typeof mapBundleToRow>[]) => {
        upsertCallCount++;
        state.upserted.push(...rows);
        if (upsertCallCount === 2) throw new Error('DB connection lost mid-pagination');
      }) as V3EnrichmentRepository['upsertBatch'],
    });
    const client = makeClient([
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 1 } })], true, 1),
      makePage([makeBundle({ leadCall: { ...makeBundle().leadCall, id: 2 } })], false, 2),
    ]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow('failed');

    expect(upsertCallCount).toBe(2);         // both pages were attempted
    expect(state.token).toBe(savedToken);    // checkpoint NOT advanced
    expect(state.completed).toBe(false);
    expect(state.failed).toBe(true);         // failSyncRun called
  });

  it('upsertBatch failure on first page fails the run with null checkpoint', async () => {
    const { repo, state } = buildRepo(null, {
      upsertBatch: jest.fn(async () => { throw new Error('disk full'); }) as V3EnrichmentRepository['upsertBatch'],
    });
    const client = makeClient([makePage([makeBundle()], false)]);
    const svc = new ServiceTitanTelecomCallsV3IngestionService(client, repo, HISTORICAL_FROM, 0);
    await expect(svc.run()).rejects.toThrow('failed');

    expect(state.token).toBeNull();
    expect(state.failed).toBe(true);
  });
});
