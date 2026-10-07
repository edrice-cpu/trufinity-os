import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const DAY_MS = 24 * 60 * 60 * 1000;

type MatchBasis = 'SAME_EQUIPMENT' | 'SAME_ADDRESS';

interface RepeatVisit {
  jobId: string;
  jobNumber: string | null;
  createdOn: Date;
  priorJobId: string;
  priorJobNumber: string | null;
  priorCompletedOn: Date;
  locationId: string;
  customerId: string | null;
  department: string | null;
  matchBasis: MatchBasis;
  taggedCallback: boolean;
}

// CASE (not AND) so jsonb_array_length never runs on a non-array value -
// Postgres doesn't guarantee left-to-right evaluation of AND/OR.
const HAS_EQUIPMENT = (alias: string) =>
  `(CASE WHEN jsonb_typeof(${alias}.payload->'equipmentIds') = 'array' THEN jsonb_array_length(${alias}.payload->'equipmentIds') > 0 ELSE false END)`;

// For each non-canceled job created in the window, the most recent OTHER job
// at the same ServiceTitan location (address) completed within the repeat
// window before it. "Same system": when both jobs carry equipmentIds they
// must share at least one; when either has none, the address match stands on
// its own and the finding says so (matchBasis = SAME_ADDRESS).
async function repeatVisits(database: Knex, start: Date, end: Date): Promise<RepeatVisit[]> {
  const result = await database.raw<{ rows: {
    job_id: string; job_number: string | null; created_on: Date; prior_job_id: string; prior_job_number: string | null;
    prior_completed_on: Date; location_id: string; customer_id: string | null; department: string | null;
    same_equipment: boolean; tagged_callback: boolean;
  }[] }>(`
    SELECT DISTINCT ON (j.source_id)
           j.source_id AS job_id,
           j.payload->>'jobNumber' AS job_number,
           (j.payload->>'createdOn')::timestamptz AS created_on,
           p.source_id AS prior_job_id,
           p.payload->>'jobNumber' AS prior_job_number,
           (p.payload->>'completedOn')::timestamptz AS prior_completed_on,
           j.payload->>'locationId' AS location_id,
           j.payload->>'customerId' AS customer_id,
           bu.payload->>'name' AS department,
           (${HAS_EQUIPMENT('j')} AND ${HAS_EQUIPMENT('p')}) AS same_equipment,
           (j.payload->>'recallForId' IS NOT NULL OR j.payload->>'warrantyId' IS NOT NULL) AS tagged_callback
    FROM raw_st_jobs j
    JOIN raw_st_jobs p
      ON p.is_latest = true
     AND p.source_id <> j.source_id
     AND p.payload->>'locationId' = j.payload->>'locationId'
     AND p.payload->>'jobStatus' = 'Completed'
     AND (p.payload->>'completedOn')::timestamptz < (j.payload->>'createdOn')::timestamptz
     AND (p.payload->>'completedOn')::timestamptz >= (j.payload->>'createdOn')::timestamptz - (? * interval '1 day')
     AND (CASE WHEN ${HAS_EQUIPMENT('j')} AND ${HAS_EQUIPMENT('p')}
          THEN EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(j.payload->'equipmentIds') je
            JOIN jsonb_array_elements_text(p.payload->'equipmentIds') pe ON pe = je
          )
          ELSE true END)
    LEFT JOIN raw_st_business_units bu ON bu.is_latest = true AND bu.source_id = j.payload->>'businessUnitId'
    WHERE j.is_latest = true
      AND COALESCE(j.payload->>'jobStatus', '') <> 'Canceled'
      AND j.payload->>'locationId' IS NOT NULL
      AND (j.payload->>'createdOn')::timestamptz >= ?
      AND (j.payload->>'createdOn')::timestamptz < ?
    ORDER BY j.source_id, prior_completed_on DESC`, [env.DETECT_O07_REPEAT_WINDOW_DAYS, start, end]);

  return result.rows.map((row) => ({
    jobId: row.job_id,
    jobNumber: row.job_number,
    createdOn: new Date(row.created_on),
    priorJobId: row.prior_job_id,
    priorJobNumber: row.prior_job_number,
    priorCompletedOn: new Date(row.prior_completed_on),
    locationId: row.location_id,
    customerId: row.customer_id,
    department: row.department,
    matchBasis: row.same_equipment ? 'SAME_EQUIPMENT' : 'SAME_ADDRESS',
    taggedCallback: row.tagged_callback,
  }));
}

// O-07 (AMBER): second visit to the same address inside 30 days on the same
// system (SPEC-BI-001 Section 5.2). One finding per repeat job, raised for
// jobs created in the current window - including ones ServiceTitan already
// tagged as recall/warranty (taggedCallback says which), since the spec flags
// every repeat visit. period_start is the repeat job's own creation time, so
// later Detect runs update the same alert instead of re-raising it.
export async function evaluateRepeatVisit(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const visits = await repeatVisits(database, window.periodStart, window.periodEnd);

  return visits.map((visit) => {
    const daysSincePriorVisit = Math.floor((visit.createdOn.getTime() - visit.priorCompletedOn.getTime()) / DAY_MS);
    return {
      ruleCode: 'O-07',
      dimension: `Job #${visit.jobNumber ?? visit.jobId}`,
      periodStart: visit.createdOn,
      periodEnd: window.periodEnd,
      baselineStart: null,
      baselineEnd: null,
      metricValue: daysSincePriorVisit,
      baselineValue: null,
      details: {
        jobId: visit.jobId,
        jobNumber: visit.jobNumber,
        createdOn: visit.createdOn.toISOString(),
        priorJobId: visit.priorJobId,
        priorJobNumber: visit.priorJobNumber,
        priorCompletedOn: visit.priorCompletedOn.toISOString(),
        daysSincePriorVisit,
        locationId: visit.locationId,
        customerId: visit.customerId,
        department: visit.department,
        matchBasis: visit.matchBasis,
        taggedCallback: visit.taggedCallback,
        repeatWindowDays: env.DETECT_O07_REPEAT_WINDOW_DAYS,
      },
    };
  });
}
