// Telecom Sync Status tests
//
// Verifies the telecom-specific rows appended to getSyncStatus():
//   - TelecomCall (V2) and TelecomCallV3 (V3) health computation
//   - schedulerEnabled / checkpointAt / syncHealth fields
//   - Status normalization (V3 uses lowercase; normalized to uppercase)
//   - Staleness detection (6h threshold)
//   - Existing regular entities are NOT affected
//
// No production PostgreSQL connection — all DB calls use a mock.

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-st-token' },
}));

import { describe, expect, it, jest, beforeEach } from '@jest/globals';
import { TELECOM_SYNC_STALE_HOURS } from '../../src/modules/reporting/servicetitan-reporting.types';

// ─── Env helpers ───────────────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-require-imports
const envModule = require('../../src/config/env') as { env: Record<string, unknown> };
const ENV_DEFAULTS = {
  SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: false,
  SERVICETITAN_TELECOM_V3_SYNC_ENABLED: false,
  SERVICETITAN_TENANT_ID: 'test-tenant',
};
function setEnv(overrides: Partial<typeof ENV_DEFAULTS> = {}): void {
  Object.assign(envModule.env, { ...ENV_DEFAULTS, ...overrides });
}
beforeEach(() => setEnv({}));

// ─── DB mock factory ──────────────────────────────────────────────────────────
//
// getSyncStatus() calls db.raw() via readRows() in a specific order per entity.
// Rather than mock individual calls, we provide a fake Knex that intercepts
// db.raw() calls by matching SQL patterns.



// Build a repository instance backed by a custom fake Knex.
async function buildRepo(dbOverride: object) {
  // We need to bypass the module cache to inject a custom db.
  // The repository exports KnexServiceTitanReportingRepository — inject via constructor.
  const { KnexServiceTitanReportingRepository } = await import('../../src/modules/reporting/servicetitan-reporting.repository');
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return new KnexServiceTitanReportingRepository(dbOverride as any);
}

// ─── Mock SQL patterns for telecom rows ───────────────────────────────────────
// The telecom queries use these distinct SQL keywords/patterns:
//   sync_runs + source_system (tenantId) → 'sync_runs\n         WHERE source_system'
//   raw_sync_metadata                    → 'raw_sync_metadata'
//   raw_st_calls                         → 'raw_st_calls WHERE is_latest'
//   st_calls_v3_enrichment               → 'st_calls_v3_enrichment'
//
// Regular entity queries use: "source_system = 'ServiceTitan'" (no tenant suffix)

function isoAgo(hours: number): string {
  return new Date(Date.now() - hours * 3_600_000).toISOString();
}

function freshCheckpoint() { return isoAgo(1); }   // 1h ago — within 6h
function staleCheckpoint() { return isoAgo(8); }   // 8h ago — older than 6h

// ─── Telecom STALE_HOURS constant ─────────────────────────────────────────────

describe('TELECOM_SYNC_STALE_HOURS constant', () => {
  it('equals 6 (matching TELECOM_CHECKPOINT_STALE_HOURS in servicetitan.scheduler.ts)', () => {
    expect(TELECOM_SYNC_STALE_HOURS).toBe(6);
  });
});

// ─── getSyncStatus — telecom row structure ────────────────────────────────────

describe('getSyncStatus — telecom rows present', () => {
  it('returns TelecomCall and TelecomCallV3 rows at the end of the result', async () => {
    // All regular entity rows return empty sync_runs; telecom rows also return empty.
    // We just verify the entity types appear.
    const db = {
      raw: jest.fn(async () => ({ rows: [] })),
    };
    const repo = await buildRepo(db);
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: false, SERVICETITAN_TELECOM_V3_SYNC_ENABLED: false });
    const rows = await repo.getSyncStatus();
    const entityTypes = rows.map((r) => r.entityType);
    expect(entityTypes).toContain('TelecomCall');
    expect(entityTypes).toContain('TelecomCallV3');
    // Regular entities still present
    expect(entityTypes).toContain('Customer');
    expect(entityTypes).toContain('Job');
  });

  it('telecom rows appear after regular entities (appended at end)', async () => {
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const last2 = rows.slice(-2).map((r) => r.entityType);
    expect(last2).toEqual(['TelecomCall', 'TelecomCallV3']);
  });
});

// ─── syncHealth: DISABLED ─────────────────────────────────────────────────────

describe('syncHealth — DISABLED', () => {
  it('TelecomCall reports DISABLED when SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED=false', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: false, SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true });
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('DISABLED');
    expect(v2.schedulerEnabled).toBe(false);
  });

  it('TelecomCallV3 reports DISABLED when SERVICETITAN_TELECOM_V3_SYNC_ENABLED=false', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true, SERVICETITAN_TELECOM_V3_SYNC_ENABLED: false });
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v3.syncHealth).toBe('DISABLED');
    expect(v3.schedulerEnabled).toBe(false);
  });

  it('DISABLED takes priority even when a checkpoint exists', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: false });
    const syncRunsRow = { status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 100 };
    const metadataRow = { last_synced_at: freshCheckpoint() };
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [metadataRow] };
        if (sql.includes('sync_runs')) return { rows: [syncRunsRow] };
        return { rows: [] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('DISABLED');
  });
});

// ─── syncHealth: NEVER_SYNCED ─────────────────────────────────────────────────

describe('syncHealth — NEVER_SYNCED', () => {
  it('reports NEVER_SYNCED when no raw_sync_metadata row exists', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('NEVER_SYNCED');
    expect(v2.checkpointAt).toBeNull();
    expect(v2.lastSuccessfulSyncAt).toBeNull();
  });

  it('reports NEVER_SYNCED when checkpoint row exists but last_synced_at is null', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: null }] };
        return { rows: [] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('NEVER_SYNCED');
  });
});

// ─── syncHealth: HEALTHY ──────────────────────────────────────────────────────

describe('syncHealth — HEALTHY', () => {
  it('reports HEALTHY when checkpoint is within the last 6h', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 50 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('HEALTHY');
    expect(v2.schedulerEnabled).toBe(true);
  });

  it('returns checkpointAt and lastSuccessfulSyncAt equal to raw_sync_metadata.last_synced_at', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        return { rows: [] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.checkpointAt).toBe(checkpoint);
    expect(v2.lastSuccessfulSyncAt).toBe(checkpoint);
  });
});

// ─── syncHealth: STALE ────────────────────────────────────────────────────────

describe('syncHealth — STALE', () => {
  it('reports STALE when checkpoint is older than 6h and last run did not fail', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = staleCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 10 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('STALE');
  });
});

// ─── syncHealth: FAILED ───────────────────────────────────────────────────────

describe('syncHealth — FAILED', () => {
  it('reports FAILED when lastRunStatus is FAILED (uppercase)', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'FAILED', started_at: new Date(), completed_at: new Date(), records_processed: 0 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('FAILED');
  });

  it('FAILED takes priority over STALE (last run failed even with old checkpoint)', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = staleCheckpoint(); // old checkpoint
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'FAILED', started_at: new Date(), completed_at: new Date(), records_processed: 0 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.syncHealth).toBe('FAILED');
  });
});

// ─── V3 lowercase status normalization ───────────────────────────────────────

describe('syncHealth — V3 status normalization', () => {
  it('normalizes lowercase "completed" to "COMPLETED" for V3 rows', async () => {
    setEnv({ SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        // V3 writes lowercase status strings
        if (sql.includes('sync_runs')) return { rows: [{ status: 'completed', started_at: new Date(), completed_at: new Date(), records_processed: 20 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v3.lastRunStatus).toBe('COMPLETED');
    expect(v3.syncHealth).toBe('HEALTHY');
  });

  it('normalizes lowercase "failed" to "FAILED" and sets syncHealth=FAILED', async () => {
    setEnv({ SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'failed', started_at: new Date(), completed_at: new Date(), records_processed: 0 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v3.lastRunStatus).toBe('FAILED');
    expect(v3.syncHealth).toBe('FAILED');
  });
});

// ─── Record counts ────────────────────────────────────────────────────────────

describe('getSyncStatus — record counts', () => {
  it('returns raw_st_calls count for TelecomCall', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 300 }] };
        if (sql.includes('raw_st_calls')) return { rows: [{ n: 3570 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.latestRawRecordCount).toBe(3570);
    expect(v2.lastRunRecordsProcessed).toBe(300);
  });

  it('returns st_calls_v3_enrichment count for TelecomCallV3', async () => {
    setEnv({ SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'completed', started_at: new Date(), completed_at: new Date(), records_processed: 150 }] };
        if (sql.includes('st_calls_v3_enrichment')) return { rows: [{ n: 2800 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v3.latestRawRecordCount).toBe(2800);
  });
});

// ─── No sync_run row (never run) ─────────────────────────────────────────────

describe('getSyncStatus — missing sync_run row', () => {
  it('returns null for all run fields when no sync_runs row exists', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    expect(v2.lastRunStatus).toBeNull();
    expect(v2.lastRunStartedAt).toBeNull();
    expect(v2.lastRunCompletedAt).toBeNull();
    expect(v2.lastRunRecordsProcessed).toBeNull();
  });
});

// ─── Existing regular entities unaffected ────────────────────────────────────

describe('getSyncStatus — regular entities unchanged', () => {
  it('regular entity rows do not have schedulerEnabled/syncHealth fields', async () => {
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const customer = rows.find((r) => r.entityType === 'Customer')!;
    expect(customer.schedulerEnabled).toBeUndefined();
    expect(customer.syncHealth).toBeUndefined();
    expect(customer.checkpointAt).toBeUndefined();
  });

  it('returns 9 regular entities + 2 telecom entities = 11 total rows', async () => {
    const db = { raw: jest.fn(async () => ({ rows: [] })) };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    expect(rows).toHaveLength(11);
  });
});

// ─── Privacy — no credentials or error payloads ───────────────────────────────

describe('getSyncStatus — privacy', () => {
  it('does not expose API credentials, tokens or raw error messages', async () => {
    setEnv({ SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true });
    const checkpoint = staleCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'FAILED', started_at: new Date(), completed_at: new Date(), records_processed: 0 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const raw = JSON.stringify(rows.find((r) => r.entityType === 'TelecomCall'));
    expect(raw).not.toMatch(/token/i);
    expect(raw).not.toMatch(/access_key/i);
    expect(raw).not.toMatch(/client_secret/i);
    expect(raw).not.toMatch(/password/i);
    expect(raw).not.toMatch(/phone/i);
  });
});

// ─── Both healthy ─────────────────────────────────────────────────────────────

describe('getSyncStatus — both V2 and V3 healthy', () => {
  it('both report HEALTHY when both schedulers enabled and checkpoints fresh', async () => {
    setEnv({
      SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true,
      SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true,
    });
    const checkpoint = freshCheckpoint();
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) return { rows: [{ last_synced_at: checkpoint }] };
        if (sql.includes('sync_runs')) return { rows: [{ status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 100 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v2.syncHealth).toBe('HEALTHY');
    expect(v3.syncHealth).toBe('HEALTHY');
  });
});

// ─── V2 healthy / V3 stale ────────────────────────────────────────────────────

describe('getSyncStatus — V2 healthy / V3 stale', () => {
  it('correctly reports different health states for V2 and V3 independently', async () => {
    setEnv({
      SERVICETITAN_TELECOM_CALLS_SYNC_ENABLED: true,
      SERVICETITAN_TELECOM_V3_SYNC_ENABLED: true,
    });
    const freshTs = freshCheckpoint();
    const staleTs = staleCheckpoint();
    let callCount = 0;
    const db = {
      raw: jest.fn(async (sql: string) => {
        if (sql.includes('raw_sync_metadata')) {
          // First call = V2 checkpoint (fresh), second call = V3 checkpoint (stale).
          callCount++;
          return { rows: [{ last_synced_at: callCount === 1 ? freshTs : staleTs }] };
        }
        if (sql.includes('sync_runs')) return { rows: [{ status: 'COMPLETED', started_at: new Date(), completed_at: new Date(), records_processed: 50 }] };
        return { rows: [{ n: 0 }] };
      }),
    };
    const repo = await buildRepo(db);
    const rows = await repo.getSyncStatus();
    const v2 = rows.find((r) => r.entityType === 'TelecomCall')!;
    const v3 = rows.find((r) => r.entityType === 'TelecomCallV3')!;
    expect(v2.syncHealth).toBe('HEALTHY');
    expect(v3.syncHealth).toBe('STALE');
  });
});

// ─── DB failure ───────────────────────────────────────────────────────────────

describe('getSyncStatus — DB failure', () => {
  it('propagates DB errors', async () => {
    const db = {
      raw: jest.fn(async () => { throw new Error('DB gone'); }),
    };
    const repo = await buildRepo(db);
    await expect(repo.getSyncStatus()).rejects.toThrow('DB gone');
  });
});
