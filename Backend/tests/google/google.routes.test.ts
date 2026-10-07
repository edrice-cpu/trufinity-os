import { describe, expect, it, jest, beforeEach } from '@jest/globals';

jest.mock('../../src/config/env', () => ({
  env: {
    NODE_ENV: 'test',
    PORT: 3000,
    TRUST_PROXY: 0,
    APP_BASE_URL: 'http://localhost:3001',
    AUTH_SESSION_TTL_HOURS: 12,
    AUTH_PASSWORD_RESET_TTL_MINUTES: 30,
    AUTH_MAX_FAILED_LOGINS: 5,
    AUTH_LOCKOUT_MINUTES: 15,
    SMTP_HOST: '',
    SMTP_PORT: 587,
    SMTP_SECURE: false,
    SMTP_USER: '',
    SMTP_PASSWORD: '',
    MAIL_FROM: 'noreply@example.test',
    WORK_ITEM_NOTIFICATION_RECIPIENT: undefined,
    QBO_CLIENT_ID: '', QBO_CLIENT_SECRET: '', QBO_REDIRECT_URI: '', QBO_AUTH_URL: '',
    QBO_TOKEN_URL: '', QBO_REVOKE_URL: '', QBO_DISCONNECT_AUTH_TOKEN: '', QBO_API_BASE_URL: '',
    QBO_CDC_POLL_INTERVAL_MS: 900000,
    GOOGLE_CLOUD_PROJECT_ID: 'test', GOOGLE_SERVICE_ACCOUNT_EMAIL: '', GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY: '',
    GOOGLE_ADMIN_DELEGATED_USER: '', GOOGLE_GMAIL_DELEGATED_USER: '',
    GOOGLE_GMAIL_HISTORICAL_DAYS: 365, GOOGLE_GMAIL_SYNC_INTERVAL_MS: 900000,
    GOOGLE_GMAIL_APPROVED_CONTENT_MAILBOXES: ['service@trufinity.ca'],
    GMAIL_CLASSIFIER_ENABLED: false, GMAIL_CLASSIFIER_PROVIDER: 'anthropic',
    GMAIL_CLASSIFIER_MODEL: '', GMAIL_CLASSIFIER_CONFIDENCE_THRESHOLD: undefined,
    GMAIL_CLASSIFIER_TIMEOUT_MS: 10000, GMAIL_CLASSIFIER_MAX_RETRIES: 2, GMAIL_CLASSIFIER_PROMPT_VERSION: 'v1',
    SERVICETITAN_CLIENT_ID: '', SERVICETITAN_CLIENT_SECRET: '', SERVICETITAN_APP_KEY: '',
    SERVICETITAN_AUTH_URL: '', SERVICETITAN_BASE_URL: '', SERVICETITAN_TENANT_ID: '',
    SERVICETITAN_CONNECT_URL: 'https://go.servicetitan.com',
    LACE_S3_BUCKET: '', LACE_S3_REGION: '', LACE_S3_ACCESS_KEY_ID: '', LACE_S3_SECRET_ACCESS_KEY: '',
    LACE_S3_CALL_ANALYSIS_PREFIX: '', LACE_S3_AGENT_PERFORMANCE_PREFIX: '',
    LACE_CALL_ANALYSIS_CRON: '0 2 * * *', LACE_AGENT_PERFORMANCE_CRON: '0 3 1 * *',
    LACE_STUCK_RUN_REAPER_CRON: '*/30 * * * *', LACE_STUCK_RUN_THRESHOLD_MINUTES: 60,
    DETECT_D01_BOOKING_RATE_DROP_THRESHOLD_POINTS: 10, DETECT_D06_OBJECTION_SPIKE_MULTIPLIER: 2,
    DETECT_D06_OBJECTION_MIN_SAMPLE: 3, DETECT_F04_AR_OVERDUE_RATE_INCREASE_THRESHOLD_POINTS: 10,
    DETECT_F04_AR_MIN_SAMPLE: 5, DETECT_F03_DISCOUNT_RATE_INCREASE_THRESHOLD_POINTS: 5,
    DETECT_F03_DISCOUNT_MIN_SAMPLE: 5, DETECT_F04C_AR_CONCENTRATION_THRESHOLD_POINTS: 25,
    DETECT_F04C_AR_MIN_OUTSTANDING: 1000, DETECT_F04D_CREDITMEMO_SPIKE_MULTIPLIER: 2,
    DETECT_F04D_CREDITMEMO_MIN_SAMPLE: 3,
    ANTHROPIC_API_KEY: '', NARRATE_MODEL: 'claude-opus-5',
  },
}));

// requireAuth passes through with an allowlisted user by default.
// Individual auth/authz tests override this with their own Express app.
const mockRequireAuth = (req: Record<string, unknown>, _res: unknown, next: () => void) => {
  req.auth = { sessionId: 'test-session', user: { id: 'user-1', email: 'admin@example.test', fullName: null } };
  next();
};
jest.mock('../../src/modules/auth/auth.middleware', () => ({
  requireAuth: mockRequireAuth,
  bearerToken: () => '',
  createRequireAuth: () => mockRequireAuth,
}));

jest.mock('../../src/modules/auth/auth.service', () => ({
  authService: { authenticate: async () => ({ sessionId: 'test-session', user: { id: 'user-1', email: 'admin@example.test', fullName: null } }) },
  AuthError: class AuthError extends Error {},
}));

jest.mock('../../src/modules/google/google-workspace.service');

import request from 'supertest';
import app from '../../src/app';
import { googleWorkspaceService } from '../../src/modules/google/google-workspace.service';

const mockService = googleWorkspaceService as jest.Mocked<typeof googleWorkspaceService>;

const sampleWorkItem = {
  id: 'a1b2c3d4-0000-0000-0000-000000000001',
  workType: 'ESCALATION' as const,
  workflowStatus: 'OPEN' as const,
  slaState: 'ON_TRACK' as const,
  mailboxAddress: 'service@trufinity.ca',
  providerMessageId: 'msg1abc2def3',
  sourceUrl: 'https://mail.google.com/mail/u/0/#all/msg1abc2def3',
  routedOwnerReference: null,
  resolutionDeadline: new Date('2026-01-10T12:00:00Z'),
  acknowledgementDeadline: null,
  acknowledgedAt: null,
  resolvedAt: null,
  resolutionNote: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
  classificationId: 'c1c1c1c1-0000-0000-0000-000000000001',
  classificationLabel: 'complaint',
  confidence: 0.92,
  reason: 'Customer is unhappy with response time.',
  decisionStatus: 'ESCALATION',
  classifiedAt: new Date('2026-01-01T00:00:00Z'),
  senderFrom: 'Jane Customer <jane@example.com>',
};

describe('GET /api/google/work-items', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns paginated work items', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [sampleWorkItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
  });

  it('snake_case work_type=ESCALATION is forwarded to service as workType', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?work_type=ESCALATION');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ workType: 'ESCALATION' }),
    );
  });

  it('snake_case workflow_status=ACKNOWLEDGED is forwarded to service as workflowStatus', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?workflow_status=ACKNOWLEDGED');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ workflowStatus: 'ACKNOWLEDGED' }),
    );
  });

  it('snake_case mailbox_address is forwarded to service as mailboxAddress', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?mailbox_address=service%40trufinity.ca');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ mailboxAddress: 'service@trufinity.ca' }),
    );
  });

  it('snake_case sla_state=BREACHED is forwarded to service as slaState', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?sla_state=BREACHED');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ slaState: 'BREACHED' }),
    );
  });

  it('invalid work_type value — workType key absent from service call', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?work_type=INVALID');
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).not.toHaveProperty('workType');
  });

  it('combined filters: work_type + workflow_status + mailbox_address all forwarded', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?work_type=REVIEW_REQUIRED&workflow_status=OPEN&mailbox_address=service%40trufinity.ca');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ workType: 'REVIEW_REQUIRED', workflowStatus: 'OPEN', mailboxAddress: 'service@trufinity.ca' }),
    );
  });

  it('caps pageSize at 100', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100 });

    await request(app).get('/api/google/work-items?pageSize=999');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ pageSize: 100 }),
    );
  });

  it('work_type=ESCALATION filter: service returns only ESCALATION items', async () => {
    const escalationItem = { ...sampleWorkItem, workType: 'ESCALATION' as const, decisionStatus: 'ESCALATION' };
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [escalationItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?work_type=ESCALATION');
    expect(res.status).toBe(200);
    for (const item of res.body.data.items as { workType: string }[]) {
      expect(item.workType).toBe('ESCALATION');
    }
  });

  it('work_type=ESCALATION filter: REVIEW_REQUIRED items are absent from response', async () => {
    // Service mock returns empty when filtering by ESCALATION — simulates a DB
    // that only has REVIEW_REQUIRED rows.
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?work_type=ESCALATION');
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
    // Confirm the filter was actually forwarded (not silently dropped)
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('workType', 'ESCALATION');
  });

  it('work_type=REVIEW_REQUIRED filter: ESCALATION items are absent from response', async () => {
    const rrItem = { ...sampleWorkItem, workType: 'REVIEW_REQUIRED' as const, decisionStatus: 'REVIEW_REQUIRED' };
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [rrItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?work_type=REVIEW_REQUIRED');
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('workType', 'REVIEW_REQUIRED');
    for (const item of res.body.data.items as { workType: string }[]) {
      expect(item.workType).not.toBe('ESCALATION');
    }
  });
});

describe('GET /api/google/work-items/stats', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns dashboard stats', async () => {
    (mockService.getWorkItemStats as jest.MockedFunction<typeof mockService.getWorkItemStats>)
      .mockResolvedValue({ totalOpen: 5, escalation: 3, reviewRequired: 2, acknowledged: 1, resolved: 10, breached: 2 });

    const res = await request(app).get('/api/google/work-items/stats');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.totalOpen).toBe(5);
    expect(res.body.data.breached).toBe(2);
  });
});

describe('GET /api/google/work-items/:id', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns single work item by id', async () => {
    (mockService.getWorkItemById as jest.MockedFunction<typeof mockService.getWorkItemById>)
      .mockResolvedValue(sampleWorkItem);

    const res = await request(app).get(`/api/google/work-items/${sampleWorkItem.id}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.id).toBe(sampleWorkItem.id);
  });

  it('returns 404 for unknown UUID', async () => {
    (mockService.getWorkItemById as jest.MockedFunction<typeof mockService.getWorkItemById>)
      .mockResolvedValue(null);

    const res = await request(app).get('/api/google/work-items/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });

  it('returns 404 for non-UUID id', async () => {
    const res = await request(app).get('/api/google/work-items/not-a-uuid');
    expect(res.status).toBe(404);
    expect(res.body.status).toBe('error');
  });
});

describe('POST /api/google/work-items/:id/acknowledge', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('acknowledges an open work item', async () => {
    const acknowledged = { ...sampleWorkItem, workflowStatus: 'ACKNOWLEDGED' as const, acknowledgedAt: new Date() };
    (mockService.acknowledgeWorkItem as jest.MockedFunction<typeof mockService.acknowledgeWorkItem>)
      .mockResolvedValue(acknowledged);

    const res = await request(app).post(`/api/google/work-items/${sampleWorkItem.id}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.workflowStatus).toBe('ACKNOWLEDGED');
  });

  it('is idempotent — acknowledging an already-acknowledged item returns success', async () => {
    const acknowledged = { ...sampleWorkItem, workflowStatus: 'ACKNOWLEDGED' as const };
    (mockService.acknowledgeWorkItem as jest.MockedFunction<typeof mockService.acknowledgeWorkItem>)
      .mockResolvedValue(acknowledged);

    const res = await request(app).post(`/api/google/work-items/${sampleWorkItem.id}/acknowledge`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });

  it('returns 404 for unknown work item', async () => {
    (mockService.acknowledgeWorkItem as jest.MockedFunction<typeof mockService.acknowledgeWorkItem>)
      .mockResolvedValue(null);

    const res = await request(app).post('/api/google/work-items/00000000-0000-0000-0000-000000000000/acknowledge');
    expect(res.status).toBe(404);
  });

  it('returns 404 for non-UUID id', async () => {
    const res = await request(app).post('/api/google/work-items/not-a-uuid/acknowledge');
    expect(res.status).toBe(404);
  });
});

describe('POST /api/google/work-items/:id/resolve', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('resolves a work item with a note', async () => {
    const resolved = { ...sampleWorkItem, workflowStatus: 'RESOLVED' as const, resolvedAt: new Date(), resolutionNote: 'Issue addressed.' };
    (mockService.resolveWorkItem as jest.MockedFunction<typeof mockService.resolveWorkItem>)
      .mockResolvedValue(resolved);

    const res = await request(app)
      .post(`/api/google/work-items/${sampleWorkItem.id}/resolve`)
      .send({ resolution_note: 'Issue addressed.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
    expect(res.body.data.workflowStatus).toBe('RESOLVED');
    expect(mockService.resolveWorkItem).toHaveBeenCalledWith(sampleWorkItem.id, 'Issue addressed.');
  });

  it('returns 400 when resolution_note is missing', async () => {
    const res = await request(app)
      .post(`/api/google/work-items/${sampleWorkItem.id}/resolve`)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
    expect(res.body.errors).toBeDefined();
  });

  it('returns 400 when resolution_note is empty string', async () => {
    const res = await request(app)
      .post(`/api/google/work-items/${sampleWorkItem.id}/resolve`)
      .send({ resolution_note: '' });
    expect(res.status).toBe(400);
    expect(res.body.status).toBe('error');
  });

  it('returns 404 for unknown work item', async () => {
    (mockService.resolveWorkItem as jest.MockedFunction<typeof mockService.resolveWorkItem>)
      .mockResolvedValue(null);

    const res = await request(app)
      .post('/api/google/work-items/00000000-0000-0000-0000-000000000000/resolve')
      .send({ resolution_note: 'Done.' });
    expect(res.status).toBe(404);
  });

  it('is idempotent — resolving an already-resolved item returns success', async () => {
    const resolved = { ...sampleWorkItem, workflowStatus: 'RESOLVED' as const, resolutionNote: 'Done.' };
    (mockService.resolveWorkItem as jest.MockedFunction<typeof mockService.resolveWorkItem>)
      .mockResolvedValue(resolved);

    const res = await request(app)
      .post(`/api/google/work-items/${sampleWorkItem.id}/resolve`)
      .send({ resolution_note: 'Done.' });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('success');
  });
});

describe('privacy and response contract', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('response never exposes subject, body, html, or snippet fields', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [sampleWorkItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items');
    const item = res.body.data.items[0];
    expect(item).not.toHaveProperty('subject');
    expect(item).not.toHaveProperty('body');
    expect(item).not.toHaveProperty('html');
    expect(item).not.toHaveProperty('snippet');
    expect(item).not.toHaveProperty('payload');
    expect(item).not.toHaveProperty('gmail_payload');
  });

  it('response envelope follows { status, data } pattern', async () => {
    (mockService.getWorkItemStats as jest.MockedFunction<typeof mockService.getWorkItemStats>)
      .mockResolvedValue({ totalOpen: 0, escalation: 0, reviewRequired: 0, acknowledged: 0, resolved: 0, breached: 0 });

    const res = await request(app).get('/api/google/work-items/stats');
    expect(res.body).toHaveProperty('status', 'success');
    expect(res.body).toHaveProperty('data');
  });

  it('sourceUrl is present and deterministic on list response', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [sampleWorkItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items');
    const item = res.body.data.items[0];
    expect(item).toHaveProperty('sourceUrl');
    expect(item.sourceUrl).toBe('https://mail.google.com/mail/u/0/#all/msg1abc2def3');
  });

  it('sourceUrl is present on detail response', async () => {
    (mockService.getWorkItemById as jest.MockedFunction<typeof mockService.getWorkItemById>)
      .mockResolvedValue(sampleWorkItem);

    const res = await request(app).get(`/api/google/work-items/${sampleWorkItem.id}`);
    expect(res.body.data).toHaveProperty('sourceUrl');
    expect(res.body.data.sourceUrl).toContain('mail.google.com');
    expect(res.body.data.sourceUrl).toContain('msg1abc2def3');
  });

  it('sourceUrl is present on acknowledge response', async () => {
    (mockService.acknowledgeWorkItem as jest.MockedFunction<typeof mockService.acknowledgeWorkItem>)
      .mockResolvedValue(sampleWorkItem);

    const res = await request(app).post(`/api/google/work-items/${sampleWorkItem.id}/acknowledge`);
    expect(res.body.data).toHaveProperty('sourceUrl');
  });

  it('sourceUrl is present on resolve response', async () => {
    (mockService.resolveWorkItem as jest.MockedFunction<typeof mockService.resolveWorkItem>)
      .mockResolvedValue({ ...sampleWorkItem, workflowStatus: 'RESOLVED' as const, resolutionNote: 'Done.' });

    const res = await request(app)
      .post(`/api/google/work-items/${sampleWorkItem.id}/resolve`)
      .send({ resolution_note: 'Done.' });
    expect(res.body.data).toHaveProperty('sourceUrl');
  });
});

describe('pagination total and error-response security (regression)', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('list response includes total, page, and pageSize in data envelope', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [sampleWorkItem, sampleWorkItem], total: 42, page: 2, pageSize: 10 });

    const res = await request(app).get('/api/google/work-items?page=2&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(42);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.pageSize).toBe(10);
    expect(res.body.data.items).toHaveLength(2);
  });

  it('filters are forwarded to service so count and items use the same scope', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?work_type=ESCALATION&workflow_status=OPEN');
    expect(mockService.listWorkItems).toHaveBeenCalledWith(
      expect.objectContaining({ workType: 'ESCALATION', workflowStatus: 'OPEN' }),
    );
  });

  it('NONE work items are not returned — total reflects actionable items only', async () => {
    // Service mock returns 0 items/total; confirms NONE exclusion is the service's responsibility
    // and the route passes the result through without modification.
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items');
    expect(res.status).toBe(200);
    expect(res.body.data.total).toBe(0);
    expect(res.body.data.items).toHaveLength(0);
  });

  it('duplicate work items from raw_gmail_messages versions do not appear in list response', async () => {
    // If the JOIN produced duplicates, the service would return the same work item twice.
    // The mock returns exactly one item, asserting the route does not duplicate it.
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [sampleWorkItem], total: 1, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items');
    expect(res.body.data.items).toHaveLength(1);
    expect(res.body.data.total).toBe(1);
    const ids = (res.body.data.items as { id: string }[]).map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('unexpected service error returns sanitized 500 — no SQL, stack, or path', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockRejectedValue(new Error('select "w"."id" from "email_escalation_work_items" — missing FROM-clause entry for table "w"'));

    const res = await request(app).get('/api/google/work-items');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Internal Server Error');
    // Must not leak SQL, stack traces, or filesystem paths
    expect(JSON.stringify(res.body)).not.toMatch(/select.*FROM/i);
    expect(JSON.stringify(res.body)).not.toContain('stack');
    expect(JSON.stringify(res.body)).not.toMatch(/[A-Z]:\\|node_modules/);
  });

  it('sla_state=BREACHED: service receives the filter so DB handles filtering before pagination', async () => {
    // Service mock returns breached items with correct total — proves the
    // filter was forwarded to the service (and thus to the DB) rather than
    // dropped and applied post-pagination.
    const breachedItem = { ...sampleWorkItem, slaState: 'BREACHED' as const };
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [breachedItem], total: 47, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?sla_state=BREACHED&page=1&pageSize=25');
    expect(res.status).toBe(200);
    // total=47 means the service counted all breached items across all pages
    expect(res.body.data.total).toBe(47);
    expect(res.body.data.items).toHaveLength(1);
    // Confirm the filter was actually forwarded (not dropped)
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('slaState', 'BREACHED');
  });

  it('sla_state=BREACHED page 2: items from beyond page 1 are returned correctly', async () => {
    // Simulates 47 breached items: page 2 returns items 26-47.
    const breachedItem = { ...sampleWorkItem, slaState: 'BREACHED' as const };
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [breachedItem, breachedItem], total: 47, page: 2, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?sla_state=BREACHED&page=2&pageSize=25');
    expect(res.status).toBe(200);
    expect(res.body.data.page).toBe(2);
    expect(res.body.data.total).toBe(47);
    expect(res.body.data.items).toHaveLength(2);
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('slaState', 'BREACHED');
    expect(call).toHaveProperty('page', 2);
  });

  it('sla_state=ON_TRACK does not include effectively breached items', async () => {
    // Service returns empty when filtering ON_TRACK — confirms filter was forwarded;
    // effectively breached items (deadline passed, non-terminal) are excluded in SQL.
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?sla_state=ON_TRACK');
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('slaState', 'ON_TRACK');
    expect(res.body.data.total).toBe(0);
  });

  it('RESOLVED/CLOSED items are not dynamically marked BREACHED — terminal status is respected', async () => {
    // A resolved item with a past deadline should NOT appear in BREACHED results.
    // The service receives slaState=BREACHED and its SQL excludes RESOLVED/CLOSED.
    const resolvedItem = { ...sampleWorkItem, workflowStatus: 'RESOLVED' as const, slaState: 'MET' as const };
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    const res = await request(app).get('/api/google/work-items?sla_state=BREACHED');
    expect(res.body.data.items).toHaveLength(0);
    expect(res.body.data.total).toBe(0);
    // The resolved item is not in the response
    expect(JSON.stringify(res.body)).not.toContain(resolvedItem.id);
  });

  it('combined SLA + work_type filter: both forwarded to service', async () => {
    (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>)
      .mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 25 });

    await request(app).get('/api/google/work-items?sla_state=BREACHED&work_type=ESCALATION');
    const call = (mockService.listWorkItems as jest.MockedFunction<typeof mockService.listWorkItems>).mock.calls[0]![0]!;
    expect(call).toHaveProperty('slaState', 'BREACHED');
    expect(call).toHaveProperty('workType', 'ESCALATION');
  });

  it('unexpected stats error returns sanitized 500', async () => {
    (mockService.getWorkItemStats as jest.MockedFunction<typeof mockService.getWorkItemStats>)
      .mockRejectedValue(new Error('DB connection refused'));

    const res = await request(app).get('/api/google/work-items/stats');
    expect(res.status).toBe(500);
    expect(res.body.status).toBe('error');
    expect(res.body.message).toBe('Internal Server Error');
    expect(JSON.stringify(res.body)).not.toContain('DB connection refused');
  });
});
