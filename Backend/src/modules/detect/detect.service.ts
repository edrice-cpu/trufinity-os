import type { Knex } from 'knex';
import { db } from '../../database';
import { logger } from '../../utils/logger';
import { trailingWeekWindow } from './detect.types';
import type { DetectedAlertFinding } from './detect.types';
import { evaluateBookingRateDecline } from './rules/d01-booking-rate-decline.rule';
import { evaluateObjectionCategorySpikes } from './rules/d06-objection-spike.rule';
import { evaluateArAgingSpike } from './rules/f04-ar-aging-spike.rule';
import { evaluateArConcentration } from './rules/f04c-ar-concentration.rule';
import { evaluateDiscountLeakage } from './rules/f03-discount-leakage.rule';
import { evaluateCreditMemoSpike } from './rules/f04d-creditmemo-spike.rule';
import { evaluateRevenueReconciliationGap } from './rules/f05-revenue-reconciliation-gap.rule';

async function persistFinding(database: Knex, finding: DetectedAlertFinding): Promise<void> {
  await database('detected_alerts')
    .insert({
      rule_code: finding.ruleCode,
      dimension: finding.dimension,
      period_start: finding.periodStart,
      period_end: finding.periodEnd,
      baseline_start: finding.baselineStart,
      baseline_end: finding.baselineEnd,
      metric_value: finding.metricValue,
      baseline_value: finding.baselineValue,
      details: finding.details,
    })
    .onConflict(['rule_code', 'dimension', 'period_start'])
    .merge();
}

export class DetectService {
  public constructor(private readonly database: Knex = db) {}

  // Runs all Detect-layer rules for the trailing-week window ending "now" and
  // persists any findings. Safe to re-run: findings for the same rule +
  // dimension + period are replaced, not duplicated (see the unique index).
  public async run(now: Date = new Date()): Promise<{ findings: DetectedAlertFinding[] }> {
    const window = trailingWeekWindow(now);

    const [d01, d06, f04, f04c, f03, f04d, f05] = await Promise.all([
      evaluateBookingRateDecline(window, this.database),
      evaluateObjectionCategorySpikes(window, this.database),
      evaluateArAgingSpike(window, this.database),
      evaluateArConcentration(window, this.database),
      evaluateDiscountLeakage(window, this.database),
      evaluateCreditMemoSpike(window, this.database),
      evaluateRevenueReconciliationGap(window, this.database),
    ]);

    const findings = [...d01, ...d06, ...f04, ...f04c, ...f03, ...f04d, ...f05];
    for (const finding of findings) {
      await persistFinding(this.database, finding);
    }

    logger.info('[Detect] Rule evaluation completed', {
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      findingsCount: findings.length,
    });

    return { findings };
  }
}

export const detectService = new DetectService();
