export interface DetectedAlertFinding {
  ruleCode: string;
  dimension: string;
  periodStart: Date;
  periodEnd: Date;
  baselineStart: Date | null;
  baselineEnd: Date | null;
  metricValue: number;
  baselineValue: number | null;
  details: Record<string, unknown>;
}

export interface DetectionWindow {
  periodStart: Date;
  periodEnd: Date;
  baselineStart: Date;
  baselineEnd: Date;
}

// Current period = the trailing 7 days ending "now". Baseline = the 4 weeks
// immediately before that, so its length matches the current period's and a
// week-over-week comparison isn't skewed by different-sized windows.
export function trailingWeekWindow(now: Date): DetectionWindow {
  const periodEnd = now;
  const periodStart = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const baselineEnd = periodStart;
  const baselineStart = new Date(baselineEnd.getTime() - 28 * 24 * 60 * 60 * 1000);
  return { periodStart, periodEnd, baselineStart, baselineEnd };
}
