import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import request from 'supertest';
import app from '../../src/app';
import { db } from '../../src/database';

// Locks the /api/brief contract documented in frontend/FRONTEND_BUILD_GUIDE.md
// (section 4.7/4.8): the project-wide { status, data } envelope, snake_case
// columns, decimals as strings, newest first, 404 { status: 'error', message }
// for a missing alert. Changing any of this is a breaking change for the frontend.
//
// Sentinel year 2094, cleanup bounded to exactly that year - other test files
// use 2095-2099 against the same shared table concurrently, so an open-ended
// range here would delete their rows mid-test.
const YEAR_START = '2094-01-01';
const YEAR_END = '2095-01-01';

function insertAlert(overrides: Partial<Record<string, unknown>> = {}) {
  return db('detected_alerts')
    .insert({
      rule_code: 'D-01',
      dimension: 'TENANT_TOTAL',
      period_start: new Date('2094-06-08T00:00:00.000Z'),
      period_end: new Date('2094-06-15T00:00:00.000Z'),
      metric_value: 0.42,
      baseline_value: 0.55,
      details: { dropPoints: 13 },
      ...overrides,
    })
    .returning('id');
}

// File-level (not per-describe) so it runs once, after every test below.
afterAll(async () => {
  await db('detected_alerts').where('period_start', '>=', YEAR_START).andWhere('period_start', '<', YEAR_END).delete();
  await db.destroy();
});

interface AlertBody {
  id: string;
  rule_code: string;
  dimension: string;
  metric_value: string;
  narrative: string | null;
  [key: string]: unknown;
}

describe('GET /api/brief/alerts', () => {
  beforeEach(async () => {
    await db('detected_alerts').where('period_start', '>=', YEAR_START).andWhere('period_start', '<', YEAR_END).delete();
  });

  it('wraps snake_case rows in { status, data }, with decimal columns as strings and a null narrative before Narrate has run', async () => {
    const [row] = await insertAlert({ dimension: 'Shape' });
    const id = typeof row === 'object' ? (row as { id: string }).id : String(row);

    const response = await request(app).get('/api/brief/alerts');

    expect(response.status).toBe(200);
    expect((response.body as { status: string }).status).toBe('success');
    expect(Array.isArray((response.body as { data: unknown }).data)).toBe(true);
    const mine = ((response.body as { data: AlertBody[] }).data).find((a) => a.id === id);
    expect(mine).toBeDefined();
    expect(Object.keys(mine as AlertBody).sort()).toEqual(
      [
        'baseline_end', 'baseline_start', 'baseline_value', 'details', 'detected_at', 'dimension', 'id',
        'metric_value', 'narrated_at', 'narrative', 'period_end', 'period_start', 'rule_code',
      ].sort(),
    );
    expect(mine?.rule_code).toBe('D-01');
    expect(typeof mine?.metric_value).toBe('string');
    expect(Number(mine?.metric_value)).toBeCloseTo(0.42);
    expect(mine?.narrative).toBeNull();
  });

  it('returns newest detected alerts first', async () => {
    const [older] = await insertAlert({ dimension: 'Older', detected_at: new Date('2094-06-16T00:00:00Z') });
    const [newer] = await insertAlert({ dimension: 'Newer', detected_at: new Date('2094-06-17T00:00:00Z') });
    const olderId = typeof older === 'object' ? (older as { id: string }).id : String(older);
    const newerId = typeof newer === 'object' ? (newer as { id: string }).id : String(newer);

    // GET /api/brief/alerts now defaults to month-to-date; these fixtures use
    // the 2094 sentinel year, so an explicit range is needed to see them.
    const response = await request(app).get('/api/brief/alerts').query({ from: '2094-01-01', to: '2095-01-01' });

    const ids = ((response.body as { data: AlertBody[] }).data).map((a) => a.id);
    expect(ids.indexOf(newerId)).toBeGreaterThanOrEqual(0);
    expect(ids.indexOf(newerId)).toBeLessThan(ids.indexOf(olderId));
  });

  it('filters by ?ruleCode=', async () => {
    await insertAlert({ rule_code: 'D-06', dimension: 'ObjectionCategory' });
    await insertAlert({ rule_code: 'D-01', dimension: 'TENANT_TOTAL' });

    const response = await request(app).get('/api/brief/alerts').query({ ruleCode: 'D-06' });

    const body = (response.body as { data: AlertBody[] }).data;
    expect(body.length).toBeGreaterThan(0);
    expect(body.every((a) => a.rule_code === 'D-06')).toBe(true);
    expect(body.some((a) => a.dimension === 'ObjectionCategory')).toBe(true);
  });
});

describe('GET /api/brief/alerts/:id', () => {
  beforeEach(async () => {
    await db('detected_alerts').where('period_start', '>=', YEAR_START).andWhere('period_start', '<', YEAR_END).delete();
  });

  it('returns the single alert object inside { status, data }', async () => {
    const [row] = await insertAlert({ dimension: 'Solo' });
    const id = typeof row === 'object' ? (row as { id: string }).id : String(row);

    const response = await request(app).get(`/api/brief/alerts/${id}`);

    expect(response.status).toBe(200);
    const body = response.body as { status: string; data: AlertBody };
    expect(body.status).toBe('success');
    expect(Array.isArray(body.data)).toBe(false);
    expect(body.data.id).toBe(id);
    expect(body.data.dimension).toBe('Solo');
  });

  it('returns 404 { status: "error", message } for a well-formed id that does not exist', async () => {
    const response = await request(app).get('/api/brief/alerts/00000000-0000-0000-0000-000000000000');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: 'error', message: 'Alert not found' });
  });

  it('returns the same 404 (not a 500) for a malformed id', async () => {
    const response = await request(app).get('/api/brief/alerts/not-a-uuid');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ status: 'error', message: 'Alert not found' });
  });
});
