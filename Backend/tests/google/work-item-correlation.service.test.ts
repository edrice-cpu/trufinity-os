import { describe, it, expect } from '@jest/globals';
import { parseEmailAddress, KnexWorkItemCorrelationService, NoopWorkItemCorrelationService } from '../../src/modules/google/work-item-correlation.service';

// ---------------------------------------------------------------------------
// parseEmailAddress unit tests
// ---------------------------------------------------------------------------

describe('parseEmailAddress', () => {
  it('parses bare email address', () => {
    expect(parseEmailAddress('jane@example.com')).toBe('jane@example.com');
  });

  it('parses "Display Name <email>" format and returns lowercase address', () => {
    expect(parseEmailAddress('Jane Customer <Jane@Example.COM>')).toBe('jane@example.com');
  });

  it('normalizes to lowercase', () => {
    expect(parseEmailAddress('JANE@EXAMPLE.COM')).toBe('jane@example.com');
  });

  it('trims whitespace around a bare address', () => {
    expect(parseEmailAddress('  jane@example.com  ')).toBe('jane@example.com');
  });

  it('returns null for null input', () => {
    expect(parseEmailAddress(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(parseEmailAddress('')).toBeNull();
  });

  it('returns null for whitespace-only string', () => {
    expect(parseEmailAddress('   ')).toBeNull();
  });

  it('returns null for malformed address with no @', () => {
    expect(parseEmailAddress('notanemail')).toBeNull();
  });

  it('returns null for multiple @ symbols', () => {
    expect(parseEmailAddress('a@b@c.com')).toBeNull();
  });

  it('returns null for address with no domain dot', () => {
    expect(parseEmailAddress('jane@localhost')).toBeNull();
  });

  it('returns null for angle-bracket format with malformed inner address', () => {
    expect(parseEmailAddress('Jane <notanemail>')).toBeNull();
  });

  it('handles display name containing special chars', () => {
    expect(parseEmailAddress('"Smith, John" <john.smith@company.io>')).toBe('john.smith@company.io');
  });
});

// ---------------------------------------------------------------------------
// NoopWorkItemCorrelationService
// ---------------------------------------------------------------------------

describe('NoopWorkItemCorrelationService', () => {
  it('does nothing and resolves without error', async () => {
    const svc = new NoopWorkItemCorrelationService();
    await expect(svc.correlateWorkItem('any-id')).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// KnexWorkItemCorrelationService — fake-DB unit tests
// ---------------------------------------------------------------------------

const VALID_WORK_ITEM_ID = 'dddddddd-0000-0000-0000-000000000001';
const VALID_CUSTOMER_ID  = 'eeeeeeee-0000-0000-0000-000000000001';

type FakeFirstResult = Record<string, unknown> | undefined;
type FakeSelectResult = Record<string, unknown>[];

interface FakeDbCallSpec {
  workItemFirst: FakeFirstResult;
  gmailFirst: FakeFirstResult;
  customerRows: FakeSelectResult;
}

const makeFakeDb = (spec: FakeDbCallSpec, captureUpdate?: (table: string, data: Record<string, unknown>) => void) => {
  let callCount = 0;

  const makeQuery = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = {};
    q.select = () => q;
    q.where = () => q;
    q.whereRaw = () => q;
    q.whereExists = () => q;
    q.limit = () => q;
    q.update = (data: Record<string, unknown>) => {
      captureUpdate?.(table, data);
      return Promise.resolve(1);
    };
    q.first = () => {
      callCount += 1;
      if (callCount === 1) return Promise.resolve(spec.workItemFirst);
      if (callCount === 2) return Promise.resolve(spec.gmailFirst);
      return Promise.resolve(undefined);
    };
    // Make the query thenable so the customers SELECT resolves directly.
    q.then = (resolve: (v: FakeSelectResult) => void) => resolve(spec.customerRows);
    return q;
  };

  const fakeDb = (table: string) => makeQuery(table);
  fakeDb.raw = () => ({ then: (r: (v: unknown) => void) => r(null) });
  return fakeDb as unknown as import('knex').Knex;
};

describe('KnexWorkItemCorrelationService — correlateWorkItem', () => {
  it('skips correlation when work item is not found', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      { workItemFirst: undefined, gmailFirst: undefined, customerRows: [] },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('skips if already correlated — idempotent (unified_customer_id already set)', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: VALID_CUSTOMER_ID },
        gmailFirst: undefined,
        customerRows: [],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('skips if gmail message not found (no From header)', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: undefined,
        customerRows: [],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('skips if gmail payload has no From header', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [] } },
        customerRows: [],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('skips if sender email is malformed', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'not-an-email' }] } },
        customerRows: [],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('no customer match — leaves correlation null', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'unknown@stranger.com' }] } },
        customerRows: [],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('ambiguous match (2 distinct customers) — leaves correlation null', async () => {
    let updateCalled = false;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'shared@company.com' }] } },
        customerRows: [
          { id: 'cust-1', name: 'Company A' },
          { id: 'cust-2', name: 'Company B' },
        ],
      },
      () => { updateCalled = true; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(updateCalled).toBe(false);
  });

  it('single customer with multiple ACTIVE identity_mappings rows — whereExists dedup means 1 row returned, correlation succeeds', async () => {
    // whereExists is a correlated subquery that returns true/false per unified_customers row.
    // It never multiplies unified_customers rows, so one customer with N ACTIVE mappings
    // still produces exactly 1 entry in the result set — correct, unambiguous correlation.
    let capturedData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'jane@example.com' }] } },
        // Simulates the DB returning 1 row (whereExists never duplicates unified_customers rows).
        customerRows: [{ id: VALID_CUSTOMER_ID, name: 'Jane Customer' }],
      },
      (_table, data) => { capturedData = data; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(capturedData).not.toBeNull();
    expect(capturedData!['unified_customer_id']).toBe(VALID_CUSTOMER_ID);
  });

  it('customer display name is null in unified_customers — stored as null', async () => {
    let capturedData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'jane@example.com' }] } },
        customerRows: [{ id: VALID_CUSTOMER_ID, name: null }],
      },
      (_table, data) => { capturedData = data; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    expect(capturedData).not.toBeNull();
    expect(capturedData!['unified_customer_id']).toBe(VALID_CUSTOMER_ID);
    expect(capturedData!['customer_display_name']).toBeNull();
  });

  it('no raw ServiceTitan payload or customer ID in the update — only canonical fields', async () => {
    let capturedData: Record<string, unknown> | null = null;
    const fakeDb = makeFakeDb(
      {
        workItemFirst: { provider_message_id: 'msg1', unified_customer_id: null },
        gmailFirst: { payload: { headers: [{ name: 'From', value: 'Jane Customer <jane@example.com>' }] } },
        customerRows: [{ id: VALID_CUSTOMER_ID, name: 'Jane Customer' }],
      },
      (_table, data) => { capturedData = data; },
    );
    const svc = new KnexWorkItemCorrelationService(fakeDb);
    await svc.correlateWorkItem(VALID_WORK_ITEM_ID);
    // Must not expose raw ServiceTitan payload
    expect(capturedData).not.toHaveProperty('st_customer_id');
    expect(capturedData).not.toHaveProperty('raw_payload');
    expect(capturedData).not.toHaveProperty('source_specific_data');
    // Must not expose raw email body/content
    expect(capturedData).not.toHaveProperty('body');
    expect(capturedData).not.toHaveProperty('subject');
    expect(capturedData).not.toHaveProperty('snippet');
    // Should have safe canonical fields
    expect(capturedData!['unified_customer_id']).toBe(VALID_CUSTOMER_ID);
    expect(capturedData!['customer_display_name']).toBe('Jane Customer');
  });

  it('source file contains no reference to subject/body for correlation — privacy guard', () => {
    const fs = require('fs');
    const source: string = fs.readFileSync(
      require('path').resolve(__dirname, '../../src/modules/google/work-item-correlation.service.ts'),
      'utf8',
    );
    // Confirm no subject, body, or snippet access in the correlation logic
    expect(source).not.toMatch(/subject/i);
    expect(source).not.toMatch(/body/i);
    expect(source).not.toMatch(/snippet/i);
    // Confirm the JSONB path used is the QBO email path, not an invented field
    expect(source).toContain('PrimaryEmailAddr');
    expect(source).toContain('quickbooks');
  });
});

// ---------------------------------------------------------------------------
// Integration-style: parseEmailAddress handles case insensitivity for matching
// ---------------------------------------------------------------------------

describe('email normalization — case handling for DB matching', () => {
  it('both "Jane@Example.COM" and "jane@example.com" normalize to the same address', () => {
    expect(parseEmailAddress('Jane@Example.COM')).toBe(parseEmailAddress('jane@example.com'));
  });

  it('display-name variant and bare email normalize to same address', () => {
    expect(parseEmailAddress('Jane Customer <Jane@Example.com>')).toBe(parseEmailAddress('jane@example.com'));
  });

  it('extra whitespace in display-name format is ignored', () => {
    expect(parseEmailAddress('  Jane   <  JANE@EXAMPLE.COM  >  ')).toBe('jane@example.com');
  });
});
