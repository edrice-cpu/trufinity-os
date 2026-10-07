import { describe, expect, it, beforeEach, afterAll } from '@jest/globals';
import { db } from '../../src/database';
import { DeliverService } from '../../src/modules/deliver/deliver.service';

const PERIOD_START = new Date('2095-06-08T00:00:00.000Z');
// listAlerts() now defaults to month-to-date, which would hide these
// sentinel-year fixtures - pass this to see the whole test year instead.
const WIDE_RANGE = { from: new Date('2095-01-01T00:00:00.000Z'), to: new Date('2096-01-01T00:00:00.000Z') };

function insertAlert(overrides: Partial<Record<string, unknown>> = {}) {
  return db('detected_alerts').insert({
    rule_code: 'D-01',
    dimension: 'TENANT_TOTAL',
    period_start: PERIOD_START,
    period_end: new Date('2095-06-15T00:00:00.000Z'),
    // Defaults to a sentinel year (not real "now") so listAlerts()'s new
    // month-to-date default filter doesn't need every test to pass an
    // explicit dateRange, and rows stay isolated from concurrently-running
    // test files/real data that share this table.
    detected_at: new Date('2095-06-10T00:00:00.000Z'),
    metric_value: 0.5,
    baseline_value: 0.8,
    details: {},
    ...overrides,
  }).returning('id');
}

describe('DeliverService', () => {
  beforeEach(async () => {
    // Bounded to this file's own year: other test files share this table concurrently.
    await db('detected_alerts').where('period_start', '>=', '2095-01-01').andWhere('period_start', '<', '2096-01-01').delete();
  });

  afterAll(async () => {
    // Leaves the last test's rows cleaned up too, not just between tests.
    await db('detected_alerts').where('period_start', '>=', '2095-01-01').andWhere('period_start', '<', '2096-01-01').delete();
    await db.destroy();
  });

  it('lists alerts newest-first', async () => {
    await insertAlert({ dimension: 'A', detected_at: new Date('2095-06-16T00:00:00Z') });
    await insertAlert({ dimension: 'B', detected_at: new Date('2095-06-17T00:00:00Z') });

    const alerts = await new DeliverService().listAlerts({ dateRange: WIDE_RANGE });
    const relevant = alerts.filter((a) => a.period_start >= PERIOD_START && a.period_start < new Date('2096-01-01T00:00:00.000Z'));

    expect(relevant.map((a) => a.dimension)).toEqual(['B', 'A']);
  });

  it('filters by ruleCode', async () => {
    await insertAlert({ rule_code: 'D-01', dimension: 'A' });
    await insertAlert({ rule_code: 'D-06', dimension: 'B' });

    const alerts = await new DeliverService().listAlerts({ ruleCode: 'D-06', dateRange: WIDE_RANGE });
    const relevant = alerts.filter((a) => a.period_start >= PERIOD_START && a.period_start < new Date('2096-01-01T00:00:00.000Z'));

    expect(relevant).toHaveLength(1);
    expect(relevant[0].dimension).toBe('B');
  });

  it('gets a single alert by id, and returns undefined for a missing one', async () => {
    const [row] = await insertAlert({ dimension: 'Solo' });
    const id = typeof row === 'object' ? row.id : row;

    const found = await new DeliverService().getAlertById(id);
    expect(found?.dimension).toBe('Solo');

    const missing = await new DeliverService().getAlertById('00000000-0000-0000-0000-000000000000');
    expect(missing).toBeUndefined();
  });
});
