/**
 * Repository-level unit tests for getAgentMetrics().
 *
 * Strategy: mock `database.raw()` to return controlled row fixtures.
 * This validates:
 *   - SQL parameter binding order (source_system, from, to, agentId, pageSize, offset)
 *   - Result-row to AgentMetricsItem mapping (all 16 fields)
 *   - count() helper coercion (string→int, negative→0, undefined→0)
 *   - nullableString() and toIso() helpers
 *   - Pagination arithmetic (LIMIT / OFFSET)
 *   - NULL agent_id group preservation
 *   - Source-system isolation
 *
 * No real database connection is used. The `db` module is mocked before import.
 */

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-token' },
}));

import { describe, expect, it, jest } from '@jest/globals';
import type { AgentMetricsItem } from '../../src/modules/reporting/servicetitan-reporting.types';
import { KnexServiceTitanReportingRepository } from '../../src/modules/reporting/servicetitan-reporting.repository';
import type { Knex } from 'knex';

// ─── Fixture helpers ──────────────────────────────────────────────────────────

/**
 * Simulates a raw SQL row as PostgreSQL would return it.
 * All counts come back as numbers (::int cast), durations as bigint-compatible numbers.
 */
function makeRawRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    agent_id: 'agent-1',
    agent_name: 'Alice Smith',
    total_calls: 50,
    inbound_calls: 30,
    outbound_calls: 20,
    abandoned_calls: 3,
    booked_calls: 15,
    unbooked_calls: 7,
    excused_calls: 2,
    not_lead_calls: 3,
    classified_calls: 47,
    unclassified_calls: 3,
    total_duration_seconds: 18000,
    avg_duration_seconds: 360,
    first_call_at: new Date('2026-09-01T08:00:00.000Z'),
    last_call_at: new Date('2026-09-30T17:00:00.000Z'),
    ...overrides,
  };
}

/** Builds a mock Knex instance whose .raw() calls return controlled data. */
function buildMockDb(
  countRow: { n: number } | undefined,
  dataRows: Record<string, unknown>[],
): Knex {
  const mockRaw = jest.fn<() => Promise<unknown>>();

  // First call = count query, second call = data query.
  mockRaw
    .mockResolvedValueOnce({ rows: countRow !== undefined ? [countRow] : [] })
    .mockResolvedValueOnce({ rows: dataRows });

  return { raw: mockRaw } as unknown as Knex;
}

/** Captures all raw() calls so SQL text and bindings can be inspected. */
function capturingMockDb(
  countRow: { n: number },
  dataRows: Record<string, unknown>[],
): { db: Knex; calls: Array<[string, unknown[]]> } {
  const calls: Array<[string, unknown[]]> = [];
  const mockRaw = jest.fn<(sql: string, bindings: unknown[]) => Promise<unknown>>(
    (sql: string, bindings: unknown[]) => {
      calls.push([sql, bindings]);
      if (calls.length === 1) return Promise.resolve({ rows: [countRow] });
      return Promise.resolve({ rows: dataRows });
    },
  );
  return { db: { raw: mockRaw } as unknown as Knex, calls };
}

const FROM = new Date('2026-09-01T00:00:00.000Z');
const TO = new Date('2026-09-30T23:59:59.000Z');
const SOURCE = 'ServiceTitan:99999';

// ─── 1. All 16 fields mapped correctly ────────────────────────────────────────

describe('AgentMetrics repository — field mapping', () => {
  it('maps all 16 AgentMetricsItem fields from a raw database row', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    expect(result.data).toHaveLength(1);
    const item = result.data[0]!;

    // Identity fields
    expect(item.agentId).toBe('agent-1');
    expect(item.agentName).toBe('Alice Smith');

    // Direction counts
    expect(item.totalCalls).toBe(50);
    expect(item.inboundCalls).toBe(30);
    expect(item.outboundCalls).toBe(20);
    expect(item.abandonedCalls).toBe(3);

    // Classification counts (new)
    expect(item.bookedCalls).toBe(15);
    expect(item.unbookedCalls).toBe(7);
    expect(item.excusedCalls).toBe(2);
    expect(item.notLeadCalls).toBe(3);
    expect(item.classifiedCalls).toBe(47);
    expect(item.unclassifiedCalls).toBe(3);

    // Duration
    expect(item.totalDurationSeconds).toBe(18000);
    expect(item.avgDurationSeconds).toBe(360);

    // Timestamps
    expect(item.firstCallAt).toBe('2026-09-01T08:00:00.000Z');
    expect(item.lastCallAt).toBe('2026-09-30T17:00:00.000Z');
  });

  it('returns null agentId and agentName for the unattributed group', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({ agent_id: null, agent_name: null })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const item = result.data[0]!;
    expect(item.agentId).toBeNull();
    expect(item.agentName).toBeNull();
  });

  it('returns null firstCallAt and lastCallAt when the DB returns null', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({ first_call_at: null, last_call_at: null })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    expect(result.data[0]!.firstCallAt).toBeNull();
    expect(result.data[0]!.lastCallAt).toBeNull();
  });
});

// ─── 2. count() helper — coercion and clamping ────────────────────────────────

describe('AgentMetrics repository — count() helper behaviour', () => {
  it('coerces string counts to integers (PostgreSQL bigint comes as string in some drivers)', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({
      total_calls: '42',
      booked_calls: '10',
      unclassified_calls: '5',
    })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    expect(data[0]!.totalCalls).toBe(42);
    expect(data[0]!.bookedCalls).toBe(10);
    expect(data[0]!.unclassifiedCalls).toBe(5);
  });

  it('returns 0 for null or undefined count values', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({
      booked_calls: null,
      unbooked_calls: undefined,
      excused_calls: null,
      not_lead_calls: undefined,
      classified_calls: null,
      unclassified_calls: null,
      total_duration_seconds: null,
      avg_duration_seconds: null,
    })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    const item = data[0]!;
    expect(item.bookedCalls).toBe(0);
    expect(item.unbookedCalls).toBe(0);
    expect(item.excusedCalls).toBe(0);
    expect(item.notLeadCalls).toBe(0);
    expect(item.classifiedCalls).toBe(0);
    expect(item.unclassifiedCalls).toBe(0);
    expect(item.totalDurationSeconds).toBe(0);
    expect(item.avgDurationSeconds).toBe(0);
  });

  it('classifiedCalls + unclassifiedCalls equals totalCalls for a fully-classified agent', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({
      total_calls: 10,
      classified_calls: 7,
      unclassified_calls: 3,
    })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    const item = data[0]!;
    expect(item.classifiedCalls + item.unclassifiedCalls).toBe(item.totalCalls);
  });
});

// ─── 3. Zero counts ───────────────────────────────────────────────────────────

describe('AgentMetrics repository — zero counts', () => {
  it('returns 0 for every classification field when all counts are 0', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow({
      total_calls: 5,
      abandoned_calls: 0, booked_calls: 0, unbooked_calls: 0,
      excused_calls: 0, not_lead_calls: 0, classified_calls: 0, unclassified_calls: 5,
    })]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    const item = data[0]!;
    expect(item.abandonedCalls).toBe(0);
    expect(item.bookedCalls).toBe(0);
    expect(item.unbookedCalls).toBe(0);
    expect(item.excusedCalls).toBe(0);
    expect(item.notLeadCalls).toBe(0);
    expect(item.classifiedCalls).toBe(0);
    expect(item.unclassifiedCalls).toBe(5);
  });

  it('returns empty data array when no rows are returned', async () => {
    const db = buildMockDb({ n: 0 }, []);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    expect(result.data).toEqual([]);
    expect(result.totalCount).toBe(0);
  });
});

// ─── 4. Mixed classifications ─────────────────────────────────────────────────

describe('AgentMetrics repository — mixed classifications', () => {
  it('returns correct per-type counts for two agents with different classifications', async () => {
    const row1 = makeRawRow({ agent_id: 'a1', booked_calls: 8,  unbooked_calls: 2, classified_calls: 10, unclassified_calls: 0 });
    const row2 = makeRawRow({ agent_id: 'a2', booked_calls: 3,  unbooked_calls: 7, classified_calls: 10, unclassified_calls: 2 });
    const db = buildMockDb({ n: 2 }, [row1, row2]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    expect(data).toHaveLength(2);
    expect(data[0]!.agentId).toBe('a1');
    expect(data[0]!.bookedCalls).toBe(8);
    expect(data[0]!.unclassifiedCalls).toBe(0);
    expect(data[1]!.agentId).toBe('a2');
    expect(data[1]!.unbookedCalls).toBe(7);
    expect(data[1]!.unclassifiedCalls).toBe(2);
  });
});

// ─── 5. Null-agent group ──────────────────────────────────────────────────────

describe('AgentMetrics repository — null agent group', () => {
  it('includes the null-agent group in results and returns its classification counts', async () => {
    const nullRow = makeRawRow({
      agent_id: null, agent_name: null,
      total_calls: 12, abandoned_calls: 12,
      booked_calls: 0, unbooked_calls: 0,
      classified_calls: 12, unclassified_calls: 0,
    });
    const db = buildMockDb({ n: 1 }, [nullRow]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const item = data[0]!;
    expect(item.agentId).toBeNull();
    expect(item.totalCalls).toBe(12);
    expect(item.abandonedCalls).toBe(12);
    expect(item.bookedCalls).toBe(0);
    expect(item.classifiedCalls).toBe(12);
  });
});

// ─── 6. Pagination ────────────────────────────────────────────────────────────

describe('AgentMetrics repository — pagination', () => {
  it('returns totalCount from the count query', async () => {
    const db = buildMockDb({ n: 42 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    expect(result.totalCount).toBe(42);
  });

  it('returns correct page and pageSize in the envelope', async () => {
    const db = buildMockDb({ n: 50 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 3, 10, SOURCE);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(10);
  });

  it('passes correct LIMIT and OFFSET bindings to the data query', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 3, 10, SOURCE); // page=3, pageSize=10 → offset=20

    const dataBindings = calls[1]![1];
    // LIMIT is second-to-last, OFFSET is last
    expect(dataBindings[dataBindings.length - 2]).toBe(10); // LIMIT
    expect(dataBindings[dataBindings.length - 1]).toBe(20); // OFFSET = (3-1)*10
  });

  it('returns 0 totalCount when count row is absent', async () => {
    const db = buildMockDb(undefined, []);
    const repo = new KnexServiceTitanReportingRepository(db);
    const result = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    expect(result.totalCount).toBe(0);
  });
});

// ─── 7. SQL parameter bindings ────────────────────────────────────────────────

describe('AgentMetrics repository — SQL parameter binding order', () => {
  it('passes source_system as the first binding to both count and data queries', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    // Count query bindings
    expect(calls[0]![1][0]).toBe(SOURCE);
    // Data query bindings
    expect(calls[1]![1][0]).toBe(SOURCE);
  });

  it('passes from.toISOString() as the second binding', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    expect(calls[0]![1][1]).toBe(FROM.toISOString());
    expect(calls[1]![1][1]).toBe(FROM.toISOString());
  });

  it('passes to.toISOString() as the third binding', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    expect(calls[0]![1][2]).toBe(TO.toISOString());
    expect(calls[1]![1][2]).toBe(TO.toISOString());
  });

  it('appends agentId as a fourth binding when provided', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE, 'agent-99');

    // count bindings: [SOURCE, from, to, 'agent-99']
    expect(calls[0]![1][3]).toBe('agent-99');
    // data bindings: [SOURCE, from, to, 'agent-99', pageSize, offset]
    expect(calls[1]![1][3]).toBe('agent-99');
  });

  it('does NOT append an agentId binding when agentId is undefined', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE, undefined);

    // Count query should only have [SOURCE, from, to]
    expect(calls[0]![1]).toHaveLength(3);
    // Data query: [SOURCE, from, to, pageSize, offset]
    expect(calls[1]![1]).toHaveLength(5);
  });
});

// ─── 8. Source-system isolation ───────────────────────────────────────────────

describe('AgentMetrics repository — source-system isolation', () => {
  it('uses the exact source_system string provided — does not mix tenants', async () => {
    const tenantA = 'ServiceTitan:tenant-A';
    const tenantB = 'ServiceTitan:tenant-B';

    const { db: dbA, calls: callsA } = capturingMockDb({ n: 1 }, [makeRawRow({ agent_id: 'a-agent' })]);
    const { db: dbB, calls: callsB } = capturingMockDb({ n: 1 }, [makeRawRow({ agent_id: 'b-agent' })]);

    const repoA = new KnexServiceTitanReportingRepository(dbA);
    const repoB = new KnexServiceTitanReportingRepository(dbB);

    const resultA = await repoA.getAgentMetrics(FROM, TO, 1, 25, tenantA);
    const resultB = await repoB.getAgentMetrics(FROM, TO, 1, 25, tenantB);

    expect(callsA[0]![1][0]).toBe(tenantA);
    expect(callsB[0]![1][0]).toBe(tenantB);
    expect(resultA.data[0]!.agentId).toBe('a-agent');
    expect(resultB.data[0]!.agentId).toBe('b-agent');
  });
});

// ─── 9. Date-range filtering ──────────────────────────────────────────────────

describe('AgentMetrics repository — date-range filtering', () => {
  it('passes the exact from/to dates as ISO strings in the correct positions', async () => {
    const customFrom = new Date('2026-08-01T00:00:00.000Z');
    const customTo = new Date('2026-08-31T23:59:59.000Z');
    const { db, calls } = capturingMockDb({ n: 0 }, []);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(customFrom, customTo, 1, 25, SOURCE);

    expect(calls[0]![1][1]).toBe(customFrom.toISOString());
    expect(calls[0]![1][2]).toBe(customTo.toISOString());
    expect(calls[1]![1][1]).toBe(customFrom.toISOString());
    expect(calls[1]![1][2]).toBe(customTo.toISOString());
  });
});

// ─── 10. Database error propagation ──────────────────────────────────────────

describe('AgentMetrics repository — error handling', () => {
  it('propagates a database error thrown by the count query', async () => {
    const mockRaw = jest.fn<() => Promise<never>>().mockRejectedValue(new Error('DB timeout'));
    const repo = new KnexServiceTitanReportingRepository({ raw: mockRaw } as unknown as Knex);
    await expect(repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE)).rejects.toThrow('DB timeout');
  });

  it('propagates a database error thrown by the data query', async () => {
    const mockRaw = jest.fn<() => Promise<unknown>>();
    mockRaw
      .mockResolvedValueOnce({ rows: [{ n: 5 }] })
      .mockRejectedValueOnce(new Error('data query failed'));
    const repo = new KnexServiceTitanReportingRepository({ raw: mockRaw } as unknown as Knex);
    await expect(repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE)).rejects.toThrow('data query failed');
  });
});

// ─── 11. Preservation of existing metrics (regression) ───────────────────────

describe('AgentMetrics repository — existing metric preservation', () => {
  it('preserves all pre-existing fields alongside the six new classification fields', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    const item = data[0]!;

    // Pre-existing fields
    expect(typeof item.agentId).toMatch(/string|object/);  // string or null
    expect(typeof item.totalCalls).toBe('number');
    expect(typeof item.inboundCalls).toBe('number');
    expect(typeof item.outboundCalls).toBe('number');
    expect(typeof item.abandonedCalls).toBe('number');
    expect(typeof item.totalDurationSeconds).toBe('number');
    expect(typeof item.avgDurationSeconds).toBe('number');
    // New fields
    expect(typeof item.bookedCalls).toBe('number');
    expect(typeof item.unbookedCalls).toBe('number');
    expect(typeof item.excusedCalls).toBe('number');
    expect(typeof item.notLeadCalls).toBe('number');
    expect(typeof item.classifiedCalls).toBe('number');
    expect(typeof item.unclassifiedCalls).toBe('number');
    // All counts are non-negative integers
    const intFields: (keyof AgentMetricsItem)[] = [
      'totalCalls', 'inboundCalls', 'outboundCalls', 'abandonedCalls',
      'bookedCalls', 'unbookedCalls', 'excusedCalls', 'notLeadCalls',
      'classifiedCalls', 'unclassifiedCalls',
      'totalDurationSeconds', 'avgDurationSeconds',
    ];
    for (const field of intFields) {
      expect(item[field]).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(item[field])).toBe(true);
    }
  });

  it('does not include any PII fields (phone, payload, URL) in the response', async () => {
    const db = buildMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    const { data } = await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);
    const raw = JSON.stringify(data[0]);
    expect(raw).not.toMatch(/phone/i);
    expect(raw).not.toMatch(/recording/i);
    expect(raw).not.toMatch(/voicemail_url/i);
    expect(raw).not.toMatch(/payload/i);
  });
});

// ─── 12. SQL text validation ──────────────────────────────────────────────────

describe('AgentMetrics repository — SQL text structure', () => {
  it('data query contains COUNT(*) FILTER expressions for all six classification types', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const dataSql = calls[1]![0].toLowerCase();
    expect(dataSql).toContain("call_type = 'booked'");
    expect(dataSql).toContain("call_type = 'unbooked'");
    expect(dataSql).toContain("call_type = 'excused'");
    expect(dataSql).toContain("call_type = 'notlead'");
    expect(dataSql).toContain('call_type is not null');
    expect(dataSql).toContain('call_type is null');
  });

  it('data query uses NULLS LAST ordering for deterministic pagination', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const dataSql = calls[1]![0].toLowerCase();
    expect(dataSql).toContain('nulls last');
  });

  it('data query uses NULLIF for duration to exclude empty strings', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const dataSql = calls[1]![0].toLowerCase();
    expect(dataSql).toContain('nullif(duration');
  });

  it('count query groups by agent_id to count distinct agent groups', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const countSql = calls[0]![0].toLowerCase();
    expect(countSql).toContain('group by agent_id');
  });

  it('count query wraps in a subquery to count agent groups (not raw rows)', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE);

    const countSql = calls[0]![0].toLowerCase();
    // Must be a subquery count, not COUNT(*) on the raw table
    expect(countSql).toMatch(/count\(\*\).*from.*\(\s*select agent_id/s);
  });

  it('data query adds AND agent_id = ? when agentId is provided', async () => {
    const { db, calls } = capturingMockDb({ n: 1 }, [makeRawRow()]);
    const repo = new KnexServiceTitanReportingRepository(db);
    await repo.getAgentMetrics(FROM, TO, 1, 25, SOURCE, 'agent-42');

    const dataSql = calls[1]![0].toLowerCase();
    expect(dataSql).toContain('agent_id = ?');
  });
});
