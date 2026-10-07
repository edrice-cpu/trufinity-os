import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

interface CategoryCount {
  category: string;
  count: number;
}

// Per SPEC-BI-001 Section 5.3: "objection category rising above baseline
// SHARE of unbooked calls" - the metric is a category's share of unbooked
// calls (occurrences / total unbooked calls), not a raw occurrence count.
async function objectionShareForWindow(
  database: Knex,
  start: Date,
  end: Date,
): Promise<{ shares: Map<string, number>; counts: Map<string, number>; totalUnbooked: number }> {
  const totalRow = await database('canonical_lace_calls')
    .where({ booked: false })
    .andWhere('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .count('* as total')
    .first<{ total: string }>();
  const totalUnbooked = Number(totalRow?.total ?? 0);

  const rows: CategoryCount[] = await database('canonical_lace_calls')
    .crossJoin(database.raw('unnest(canonical_lace_calls.objections) as category'))
    .where({ booked: false })
    .whereNotNull('objections')
    .andWhere('received_at', '>=', start)
    .andWhere('received_at', '<', end)
    .groupBy('category')
    .select('category')
    .count('* as count')
    .then((result) => result as unknown as { category: string; count: string }[])
    .then((result) => result.map((r) => ({ category: r.category, count: Number(r.count) })));

  const counts = new Map(rows.map((r) => [r.category, r.count]));
  const shares = new Map(rows.map((r) => [r.category, totalUnbooked > 0 ? r.count / totalUnbooked : 0]));
  return { shares, counts, totalUnbooked };
}

// D-06: flags an objection category whose current-week share of unbooked
// calls rises above its trailing 4-week baseline share (SPEC-BI-001 Section
// 5.3: "Any Lace objection category rising above baseline share of unbooked
// calls"; exact threshold TBD from the spec - see DETECT_D06_OBJECTION_SPIKE_MULTIPLIER).
// A minimum occurrence count avoids flagging noise on rarely-occurring
// categories (e.g. 1 of 2 unbooked calls is a 100% share but not meaningful).
export async function evaluateObjectionCategorySpikes(
  window: DetectionWindow,
  database: Knex = db,
): Promise<DetectedAlertFinding[]> {
  const [current, baseline] = await Promise.all([
    objectionShareForWindow(database, window.periodStart, window.periodEnd),
    objectionShareForWindow(database, window.baselineStart, window.baselineEnd),
  ]);

  const findings: DetectedAlertFinding[] = [];
  for (const [category, currentShare] of current.shares) {
    const currentCount = current.counts.get(category) ?? 0;
    if (currentCount < env.DETECT_D06_OBJECTION_MIN_SAMPLE) continue;

    const baselineShare = baseline.shares.get(category) ?? 0;
    // No baseline occurrences at all is a new category appearing, not a
    // measurable share spike - skip rather than divide by zero.
    if (baselineShare === 0) continue;

    const multiplier = currentShare / baselineShare;
    if (multiplier < env.DETECT_D06_OBJECTION_SPIKE_MULTIPLIER) continue;

    findings.push({
      ruleCode: 'D-06',
      dimension: category,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      baselineStart: window.baselineStart,
      baselineEnd: window.baselineEnd,
      metricValue: currentShare,
      baselineValue: baselineShare,
      details: {
        currentCount,
        currentTotalUnbooked: current.totalUnbooked,
        baselineCount: baseline.counts.get(category) ?? 0,
        baselineTotalUnbooked: baseline.totalUnbooked,
        multiplier,
        thresholdMultiplier: env.DETECT_D06_OBJECTION_SPIKE_MULTIPLIER,
      },
    });
  }
  return findings;
}
