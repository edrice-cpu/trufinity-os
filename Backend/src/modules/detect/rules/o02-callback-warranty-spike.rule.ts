import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const UNKNOWN_DEPARTMENT = 'Unassigned department';

type Breakdown = 'DEPARTMENT' | 'TECHNICIAN';

interface CallbackCounts {
  dimension: string;
  technicianId: string | null;
  callbacks: number;
  total: number;
}

// Department view: of the jobs created in the window, per ServiceTitan
// business unit, how many are callbacks (recallForId or warrantyId set).
async function departmentCounts(database: Knex, start: Date, end: Date): Promise<CallbackCounts[]> {
  const result = await database.raw<{ rows: { department: string | null; callbacks: string; total: string }[] }>(`
    SELECT bu.payload->>'name' AS department,
           count(*) FILTER (WHERE j.payload->>'recallForId' IS NOT NULL OR j.payload->>'warrantyId' IS NOT NULL) AS callbacks,
           count(*) AS total
    FROM raw_st_jobs j
    LEFT JOIN raw_st_business_units bu ON bu.is_latest = true AND bu.source_id = j.payload->>'businessUnitId'
    WHERE j.is_latest = true
      AND COALESCE(j.payload->>'jobStatus', '') <> 'Canceled'
      AND (j.payload->>'createdOn')::timestamptz >= ?
      AND (j.payload->>'createdOn')::timestamptz < ?
    GROUP BY 1`, [start, end]);
  return result.rows.map((row) => ({
    dimension: row.department ?? UNKNOWN_DEPARTMENT,
    technicianId: null,
    callbacks: Number(row.callbacks),
    total: Number(row.total),
  }));
}

// Technician view: a callback is charged to the technician on the ORIGINAL
// job it points back to (recallForId, else warrantyId). The raw Jobs export's
// only technician link is soldById - per-appointment assignments aren't
// ingested - so that is the technician used. Denominator = jobs that
// technician completed in the same window.
async function technicianCounts(database: Knex, start: Date, end: Date): Promise<CallbackCounts[]> {
  const result = await database.raw<{ rows: { technician_id: string; technician_name: string | null; callbacks: string; total: string }[] }>(`
    WITH callbacks AS (
      SELECT o.payload->>'soldById' AS technician_id, count(*) AS callbacks
      FROM raw_st_jobs c
      JOIN raw_st_jobs o ON o.is_latest = true AND o.source_id = COALESCE(c.payload->>'recallForId', c.payload->>'warrantyId')
      WHERE c.is_latest = true
        AND COALESCE(c.payload->>'jobStatus', '') <> 'Canceled'
        AND (c.payload->>'createdOn')::timestamptz >= ?
        AND (c.payload->>'createdOn')::timestamptz < ?
        AND o.payload->>'soldById' IS NOT NULL
      GROUP BY 1
    ),
    completed AS (
      SELECT payload->>'soldById' AS technician_id, count(*) AS total
      FROM raw_st_jobs
      WHERE is_latest = true
        AND payload->>'soldById' IS NOT NULL
        AND payload->>'jobStatus' = 'Completed'
        AND (payload->>'completedOn')::timestamptz >= ?
        AND (payload->>'completedOn')::timestamptz < ?
      GROUP BY 1
    )
    SELECT c.technician_id, t.payload->>'name' AS technician_name,
           COALESCE(cb.callbacks, 0) AS callbacks, c.total
    FROM completed c
    LEFT JOIN callbacks cb ON cb.technician_id = c.technician_id
    LEFT JOIN raw_st_technicians t ON t.is_latest = true AND t.source_id = c.technician_id`, [start, end, start, end]);
  return result.rows.map((row) => ({
    dimension: `${row.technician_name ?? 'Technician'} (#${row.technician_id})`,
    technicianId: row.technician_id,
    callbacks: Number(row.callbacks),
    total: Number(row.total),
  }));
}

function buildFindings(
  breakdown: Breakdown,
  window: DetectionWindow,
  current: CallbackCounts[],
  baseline: CallbackCounts[],
): DetectedAlertFinding[] {
  const baselineByDimension = new Map(baseline.map((row) => [row.dimension, row]));
  const findings: DetectedAlertFinding[] = [];

  for (const cur of current) {
    const base = baselineByDimension.get(cur.dimension);
    if (!base) continue;
    if (cur.total < env.DETECT_O02_MIN_SAMPLE || base.total < env.DETECT_O02_MIN_SAMPLE) continue;

    const currentRate = cur.callbacks / cur.total;
    const baselineRate = base.callbacks / base.total;
    const increasePoints = (currentRate - baselineRate) * 100;
    if (increasePoints < env.DETECT_O02_CALLBACK_RATE_INCREASE_THRESHOLD_POINTS) continue;

    findings.push({
      ruleCode: 'O-02',
      dimension: cur.dimension,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      baselineStart: window.baselineStart,
      baselineEnd: window.baselineEnd,
      metricValue: currentRate,
      baselineValue: baselineRate,
      details: {
        breakdown,
        ...(cur.technicianId ? { technicianId: cur.technicianId } : {}),
        currentCallbackJobs: cur.callbacks,
        currentTotalJobs: cur.total,
        baselineCallbackJobs: base.callbacks,
        baselineTotalJobs: base.total,
        increasePoints,
        thresholdPoints: env.DETECT_O02_CALLBACK_RATE_INCREASE_THRESHOLD_POINTS,
      },
    });
  }
  return findings;
}

// O-02 (RED): callback rate by technician or department exceeds its rolling
// baseline by the threshold (SPEC-BI-001 Section 5.2). Callbacks are jobs
// ServiceTitan links back to an earlier job as a recall (recallForId) or
// warranty visit (warrantyId). Department = ServiceTitan business unit.
// Baseline = the same department/technician over the trailing 4 weeks.
export async function evaluateCallbackWarrantySpike(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const [deptCurrent, deptBaseline, techCurrent, techBaseline] = await Promise.all([
    departmentCounts(database, window.periodStart, window.periodEnd),
    departmentCounts(database, window.baselineStart, window.baselineEnd),
    technicianCounts(database, window.periodStart, window.periodEnd),
    technicianCounts(database, window.baselineStart, window.baselineEnd),
  ]);

  return [
    ...buildFindings('DEPARTMENT', window, deptCurrent, deptBaseline),
    ...buildFindings('TECHNICIAN', window, techCurrent, techBaseline),
  ];
}
