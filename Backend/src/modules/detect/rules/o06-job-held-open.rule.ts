import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

const DAY_MS = 24 * 60 * 60 * 1000;

interface NotInvoicedJob {
  jobId: string;
  jobNumber: string | null;
  completedOn: Date;
  jobTotal: number;
  department: string | null;
  customerId: string | null;
  locationId: string | null;
  invoiceId: string | null;
  invoiceSyncStatus: string | null;
}

// "Not invoiced" = the job's invoice was never ingested at all, or it still
// sits in ServiceTitan's 'Pending' sync status (not yet posted/exported to
// accounting). No-charge jobs are excluded - there's nothing to invoice.
async function completedNotInvoicedJobs(database: Knex, completedBefore: Date, completedFrom: Date): Promise<NotInvoicedJob[]> {
  const result = await database.raw<{ rows: {
    job_id: string; job_number: string | null; completed_on: Date; job_total: string | null; department: string | null;
    customer_id: string | null; location_id: string | null; invoice_id: string | null; invoice_sync_status: string | null;
  }[] }>(`
    SELECT j.source_id AS job_id,
           j.payload->>'jobNumber' AS job_number,
           (j.payload->>'completedOn')::timestamptz AS completed_on,
           (j.payload->>'total')::numeric AS job_total,
           bu.payload->>'name' AS department,
           j.payload->>'customerId' AS customer_id,
           j.payload->>'locationId' AS location_id,
           j.payload->>'invoiceId' AS invoice_id,
           i.payload->>'syncStatus' AS invoice_sync_status
    FROM raw_st_jobs j
    LEFT JOIN raw_st_invoices i ON i.is_latest = true AND i.source_id = j.payload->>'invoiceId'
    LEFT JOIN raw_st_business_units bu ON bu.is_latest = true AND bu.source_id = j.payload->>'businessUnitId'
    WHERE j.is_latest = true
      AND j.payload->>'jobStatus' = 'Completed'
      AND NOT COALESCE((j.payload->>'noCharge')::boolean, false)
      AND (j.payload->>'completedOn')::timestamptz < ?
      AND (j.payload->>'completedOn')::timestamptz >= ?
      AND (i.id IS NULL OR COALESCE(i.payload->>'syncStatus', 'Pending') = 'Pending')
    ORDER BY completed_on ASC, j.source_id ASC`, [completedBefore, completedFrom]);

  return result.rows.map((row) => ({
    jobId: row.job_id,
    jobNumber: row.job_number,
    completedOn: new Date(row.completed_on),
    jobTotal: Number(row.job_total ?? 0),
    department: row.department,
    customerId: row.customer_id,
    locationId: row.location_id,
    invoiceId: row.invoice_id,
    invoiceSyncStatus: row.invoice_sync_status,
  }));
}

// O-06 (AMBER): job completed in the field but not invoiced beyond threshold
// days (SPEC-BI-001 Section 5.2). One finding per job. period_start is the
// job's own completion time, so re-running Detect on later days updates the
// same alert row (unique on rule+dimension+period_start) rather than raising
// a new one each morning; detected_at keeps the date it was first flagged.
// metric_value is the job total (the revenue waiting to be billed) - a figure
// that doesn't drift day to day, so an existing narrative never goes stale.
export async function evaluateJobHeldOpen(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const now = window.periodEnd;
  const completedBefore = new Date(now.getTime() - env.DETECT_O06_NOT_INVOICED_DAYS * DAY_MS);
  const completedFrom = new Date(now.getTime() - env.DETECT_O06_LOOKBACK_DAYS * DAY_MS);

  const jobs = await completedNotInvoicedJobs(database, completedBefore, completedFrom);

  return jobs.map((job) => ({
    ruleCode: 'O-06',
    dimension: `Job #${job.jobNumber ?? job.jobId}`,
    periodStart: job.completedOn,
    periodEnd: now,
    baselineStart: null,
    baselineEnd: null,
    metricValue: job.jobTotal,
    baselineValue: null,
    details: {
      jobId: job.jobId,
      jobNumber: job.jobNumber,
      completedOn: job.completedOn.toISOString(),
      jobTotal: job.jobTotal,
      department: job.department,
      customerId: job.customerId,
      locationId: job.locationId,
      invoiceId: job.invoiceId,
      invoiceStatus: job.invoiceSyncStatus ?? 'NOT_INGESTED',
      thresholdDays: env.DETECT_O06_NOT_INVOICED_DAYS,
    },
  }));
}
