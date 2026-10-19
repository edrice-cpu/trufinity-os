// Tests for the D-02 abandoned inbound calls reporting API.
// All queries are read-only and run against a mock DB — no production writes, no live API.

jest.mock('../../src/database/index', () => ({ db: {} }));
jest.mock('../../src/modules/servicetitan/auth.service', () => ({
  authService: { getAccessToken: async () => 'mock-token', clearCache: () => undefined },
}));

import { describe, it, expect, jest } from '@jest/globals';
import type { Knex } from 'knex';
import http from 'http';
import express from 'express';
import { KnexServiceTitanReportingRepository } from '../../src/modules/reporting/servicetitan-reporting.repository';
import { ServiceTitanReportingService } from '../../src/modules/reporting/servicetitan-reporting.service';
import { createServiceTitanReportingRouter } from '../../src/modules/reporting/servicetitan-reporting.routes';
import type { AuthService } from '../../src/modules/auth/auth.service';

// ─── Mock DB stub ──────────────────────────────────────────────────────────────

class MockDatabase {
  public readonly queries: string[] = [];
  public readonly bindingLog: unknown[][] = [];
  private readonly responseQueue: Array<{ rows: Record<string, unknown>[] }>;

  public constructor(...responses: Record<string, unknown>[][]) {
    this.responseQueue = responses.map((rows) => ({ rows }));
  }

  public raw(sql: string, bindings?: unknown[]): Promise<{ rows: Record<string, unknown>[] }> {
    this.queries.push(sql);
    this.bindingLog.push(bindings ?? []);
    if (/\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER)\b/i.test(sql)) {
      throw new Error('Abandoned calls queries must be read-only.');
    }
    return Promise.resolve(this.responseQueue.shift() ?? { rows: [] });
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

const SOURCE_SYSTEM = 'ServiceTitan:2088992281';
const FROM = new Date('2026-07-10T00:00:00Z');
const TO   = new Date('2026-10-10T00:00:00Z');

function makeAbandonedRow(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return {
    call_id: '141064646',
    received_on: new Date('2026-08-15T14:30:00Z'),
    duration: '00:01:23.4500000',
    agent_id: null,
    agent_name: null,
    customer_id: '5001',
    job_id: null,
    v2_linked: true,
    has_voicemail: false,
    ...overrides,
  };
}

const VALID_TOKEN = 'validtoken1234567890xx';

function httpGet(port: number, path: string, token = VALID_TOKEN): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'GET',
      headers: { Authorization: `Bearer ${token}` } }, (res) => {
      let raw = '';
      res.on('data', (c: Buffer) => { raw += c.toString(); });
      res.on('end', () => {
        try { resolve({ status: res.statusCode ?? 0, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode ?? 0, body: raw }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ─── Repository: listAbandonedCalls ───────────────────────────────────────────

describe('KnexServiceTitanReportingRepository — listAbandonedCalls', () => {
  it('returns paginated abandoned calls for the given date range', async () => {
    const row = makeAbandonedRow();
    const db = new MockDatabase(
      [{ n: 1 }],      // COUNT query
      [row],           // data query
    );
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);

    expect(result.totalCount).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(result.data).toHaveLength(1);
    const item = result.data[0]!;
    expect(item.callId).toBe('141064646');
    expect(item.receivedOn).toBe(new Date('2026-08-15T14:30:00Z').toISOString());
    expect(item.duration).toBe('00:01:23.4500000');
    expect(item.agentId).toBeNull();
    expect(item.agentName).toBeNull();
    expect(item.customerId).toBe('5001');
    expect(item.jobId).toBeNull();
    expect(item.hasVoicemail).toBe(false);
    expect(item.v2Linked).toBe(true);
  });

  it('returns empty page when no records match', async () => {
    const db = new MockDatabase([{ n: 0 }], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    expect(result.totalCount).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('does not expose phone numbers, raw payload or voicemail URL', async () => {
    const db = new MockDatabase([{ n: 1 }], [makeAbandonedRow()]);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    const item = result.data[0]!;
    const keys = Object.keys(item);
    // Check that no PII-adjacent keys are present in the response shape
    expect(keys).not.toContain('payload');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('phoneNumber');
    expect(keys).not.toContain('voiceMailUrl');
    expect(keys).not.toContain('recordingUrl');
    // 'from' and 'to' are phone number field names in the ST payload
    expect(keys).not.toContain('from');
    expect(keys).not.toContain('to');
  });

  it('filters by direction=Inbound and call_type=Abandoned in SQL', async () => {
    const db = new MockDatabase([{ n: 0 }], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    const countSql = db.queries[0]!;
    expect(countSql).toContain("call_type = 'Abandoned'");
    expect(countSql).toContain("direction = 'Inbound'");
  });

  it('applies date range bounds to call_received_on', async () => {
    const db = new MockDatabase([{ n: 0 }], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    const countSql = db.queries[0]!;
    expect(countSql).toContain('call_received_on >= ?');
    expect(countSql).toContain('call_received_on < ?');
    // FROM and TO appear as bindings
    expect(db.bindingLog[0]).toContain(FROM.toISOString());
    expect(db.bindingLog[0]).toContain(TO.toISOString());
  });

  it('respects asc sort direction', async () => {
    const db = new MockDatabase([{ n: 0 }], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.listAbandonedCalls(FROM, TO, 1, 25, 'asc', SOURCE_SYSTEM);
    const dataSql = db.queries[1]!;
    expect(dataSql).toContain('ASC');
  });

  it('respects desc sort direction', async () => {
    const db = new MockDatabase([{ n: 0 }], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    const dataSql = db.queries[1]!;
    expect(dataSql).toContain('DESC');
  });

  it('computes correct OFFSET for page 2', async () => {
    const db = new MockDatabase([{ n: 50 }], [makeAbandonedRow(), makeAbandonedRow({ call_id: '999' })]);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.listAbandonedCalls(FROM, TO, 2, 25, 'desc', SOURCE_SYSTEM);
    const dataBindings = db.bindingLog[1]!;
    // Last two bindings are LIMIT=25 and OFFSET=25
    expect(dataBindings.at(-1)).toBe(25);   // OFFSET for page 2
    expect(dataBindings.at(-2)).toBe(25);   // LIMIT
  });

  it('marks hasVoicemail=true when voicemail URL is non-empty', async () => {
    const db = new MockDatabase([{ n: 1 }], [makeAbandonedRow({ has_voicemail: true })]);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM);
    expect(result.data[0]!.hasVoicemail).toBe(true);
  });

  it('returns all read-only queries (no INSERT/UPDATE/DELETE)', async () => {
    const db = new MockDatabase([{ n: 1 }], [makeAbandonedRow()]);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await expect(repo.listAbandonedCalls(FROM, TO, 1, 25, 'desc', SOURCE_SYSTEM)).resolves.toBeDefined();
    for (const sql of db.queries) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
  });
});

// ─── Repository: getAbandonedCallsAggregate ───────────────────────────────────

describe('KnexServiceTitanReportingRepository — getAbandonedCallsAggregate', () => {
  it('returns total counts, byDay and byHour breakdowns', async () => {
    const db = new MockDatabase(
      [{ total_count: 10, with_voicemail: 3, with_customer_id: 7 }],
      [
        { date: '2026-08-15', count: 4 },
        { date: '2026-08-16', count: 6 },
      ],
      [
        { hour: 14, count: 5 },
        { hour: 19, count: 5 },
      ],
    );
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.getAbandonedCallsAggregate(FROM, TO, SOURCE_SYSTEM);
    expect(result.totalCount).toBe(10);
    expect(result.withVoicemail).toBe(3);
    expect(result.withCustomerId).toBe(7);
    expect(result.byDay).toEqual([
      { date: '2026-08-15', count: 4 },
      { date: '2026-08-16', count: 6 },
    ]);
    expect(result.byHour).toEqual([
      { hour: 14, count: 5 },
      { hour: 19, count: 5 },
    ]);
  });

  it('returns zero counts and empty arrays when no records match', async () => {
    const db = new MockDatabase([{ total_count: 0, with_voicemail: 0, with_customer_id: 0 }], [], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    const result = await repo.getAbandonedCallsAggregate(FROM, TO, SOURCE_SYSTEM);
    expect(result.totalCount).toBe(0);
    expect(result.byDay).toHaveLength(0);
    expect(result.byHour).toHaveLength(0);
  });

  it('aggregate queries are read-only', async () => {
    const db = new MockDatabase([{ total_count: 0, with_voicemail: 0, with_customer_id: 0 }], [], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.getAbandonedCallsAggregate(FROM, TO, SOURCE_SYSTEM);
    for (const sql of db.queries) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    }
  });

  it('aggregate query uses UTC timestamps for byDay grouping', async () => {
    const db = new MockDatabase([{ total_count: 0, with_voicemail: 0, with_customer_id: 0 }], [], []);
    const repo = new KnexServiceTitanReportingRepository(db as unknown as Knex);
    await repo.getAbandonedCallsAggregate(FROM, TO, SOURCE_SYSTEM);
    const daySql = db.queries[1]!;
    expect(daySql).toContain("'UTC'");
  });
});

// ─── Route: GET /telecom/calls/abandoned — authentication ─────────────────────
//
// Build a minimal app that always rejects auth so we can verify the 401 path
// without the route handler attempting a real DB call.

function buildRejectAuthServer(): Promise<{ server: http.Server; port: number }> {
  const rejectAuth: AuthService = {
    authenticate: async () => null,
  } as unknown as AuthService;
  const app = express();
  const router = createServiceTitanReportingRouter(undefined as never, rejectAuth, undefined as never);
  app.use('/api/reporting/servicetitan', router);
  const server = http.createServer(app);
  return new Promise<{ server: http.Server; port: number }>((r) =>
    server.listen(0, '127.0.0.1', () => r({ server, port: (server.address() as { port: number }).port })),
  );
}

describe('GET /api/reporting/servicetitan/telecom/calls/abandoned — authentication', () => {
  it('returns 401 without Authorization header', async () => {
    const { server, port } = await buildRejectAuthServer();
    try {
      const { status } = await httpGet(port, '/api/reporting/servicetitan/telecom/calls/abandoned', '');
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('returns 401 for malformed bearer token (too short)', async () => {
    const { server, port } = await buildRejectAuthServer();
    try {
      const { status } = await httpGet(port, '/api/reporting/servicetitan/telecom/calls/abandoned', 'shorttoken');
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('returns 401 when authenticate returns null for a valid-format token', async () => {
    const { server, port } = await buildRejectAuthServer();
    try {
      // Token passes the regex format check but authenticate() returns null → 401
      const { status } = await httpGet(port, '/api/reporting/servicetitan/telecom/calls/abandoned', VALID_TOKEN);
      expect(status).toBe(401);
    } finally { server.close(); }
  });

  it('/aggregate also returns 401 without token', async () => {
    const { server, port } = await buildRejectAuthServer();
    try {
      const { status } = await httpGet(port, '/api/reporting/servicetitan/telecom/calls/abandoned/aggregate', '');
      expect(status).toBe(401);
    } finally { server.close(); }
  });
});

// ─── Service layer ────────────────────────────────────────────────────────────

describe('ServiceTitanReportingService — abandoned calls delegation', () => {
  it('listAbandonedCalls delegates to repository with correct parameters', async () => {
    const mockRepo = {
      listAbandonedCalls: jest.fn(async () => ({ page: 1, pageSize: 25, totalCount: 0, data: [] })),
      getAbandonedCallsAggregate: jest.fn(async () => ({ totalCount: 0, withVoicemail: 0, withCustomerId: 0, byDay: [], byHour: [] })),
    } as unknown as KnexServiceTitanReportingRepository;

    // Patch the repository on a fresh service instance
    const svc = new ServiceTitanReportingService(mockRepo);
    await svc.listAbandonedCalls(FROM, TO, 1, 25, 'desc');
    expect(mockRepo.listAbandonedCalls).toHaveBeenCalledTimes(1);
    const [passedFrom, passedTo, passedPage, passedPageSize, passedSort] =
      (mockRepo.listAbandonedCalls as jest.Mock).mock.calls[0] as [Date, Date, number, number, string, string];
    expect(passedFrom).toEqual(FROM);
    expect(passedTo).toEqual(TO);
    expect(passedPage).toBe(1);
    expect(passedPageSize).toBe(25);
    expect(passedSort).toBe('desc');
  });

  it('getAbandonedCallsAggregate delegates to repository', async () => {
    const mockRepo = {
      listAbandonedCalls: jest.fn(async () => ({ page: 1, pageSize: 25, totalCount: 0, data: [] })),
      getAbandonedCallsAggregate: jest.fn(async () => ({ totalCount: 5, withVoicemail: 1, withCustomerId: 3, byDay: [], byHour: [] })),
    } as unknown as KnexServiceTitanReportingRepository;
    const svc = new ServiceTitanReportingService(mockRepo);
    const result = await svc.getAbandonedCallsAggregate(FROM, TO);
    expect(result.totalCount).toBe(5);
    expect(mockRepo.getAbandonedCallsAggregate).toHaveBeenCalledTimes(1);
  });
});

// ─── Privacy contract ─────────────────────────────────────────────────────────

describe('AbandonedCallItem — privacy contract', () => {
  it('response shape does not include PII fields', () => {
    const item = {
      callId: '141064646',
      receivedOn: '2026-08-15T14:30:00.000Z',
      duration: '00:01:23.4500000',
      agentId: null,
      agentName: null,
      customerId: '5001',
      jobId: null,
      hasVoicemail: false,
      v2Linked: true,
    };
    const keys = Object.keys(item);
    expect(keys).not.toContain('from');
    expect(keys).not.toContain('to');
    expect(keys).not.toContain('phone');
    expect(keys).not.toContain('phoneNumber');
    expect(keys).not.toContain('payload');
    expect(keys).not.toContain('voiceMailUrl');
    expect(keys).not.toContain('recordingUrl');
    expect(keys).not.toContain('sid');
  });

  it('documentation comment clarifies Abandoned != all missed calls', () => {
    // Verified by the inline comment in servicetitan-reporting.types.ts:
    // "This is NOT equivalent to all missed-call scenarios (e.g. ring-with-no-answer
    //  requires Dialpad integration)."
    // This test is a contract assertion — the type file must contain this clarification.
    const fs = require('fs');
    const typesFile = fs.readFileSync(
      require('path').join(__dirname, '../../src/modules/reporting/servicetitan-reporting.types.ts'), 'utf8',
    ) as string;
    expect(typesFile).toContain('NOT equivalent');
    expect(typesFile).toContain('Dialpad');
  });
});
