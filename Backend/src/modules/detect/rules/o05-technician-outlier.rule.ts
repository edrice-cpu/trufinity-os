import type { Knex } from 'knex';
import { db } from '../../../database';
import { env } from '../../../config/env';
import type { DetectedAlertFinding, DetectionWindow } from '../detect.types';

interface TechnicianTickets {
  technicianId: string;
  technicianName: string | null;
  jobCount: number;
  totalValue: number;
}

// Completed, chargeable ServiceTitan jobs in the window, grouped by the
// technician who sold them (soldById - the only technician link on the raw
// Jobs export; per-appointment technician assignments aren't ingested).
async function technicianTicketsForWindow(database: Knex, start: Date, end: Date): Promise<TechnicianTickets[]> {
  const result = await database.raw<{ rows: { technician_id: string; technician_name: string | null; job_count: string; total_value: string }[] }>(`
    SELECT j.payload->>'soldById' AS technician_id,
           max(t.payload->>'name') AS technician_name,
           count(*) AS job_count,
           coalesce(sum((j.payload->>'total')::numeric), 0) AS total_value
    FROM raw_st_jobs j
    LEFT JOIN raw_st_technicians t ON t.is_latest = true AND t.source_id = j.payload->>'soldById'
    WHERE j.is_latest = true
      AND j.payload->>'soldById' IS NOT NULL
      AND j.payload->>'jobStatus' = 'Completed'
      AND NOT COALESCE((j.payload->>'noCharge')::boolean, false)
      AND (j.payload->>'completedOn')::timestamptz >= ?
      AND (j.payload->>'completedOn')::timestamptz < ?
    GROUP BY j.payload->>'soldById'`, [start, end]);

  return result.rows.map((row) => ({
    technicianId: row.technician_id,
    technicianName: row.technician_name,
    jobCount: Number(row.job_count),
    totalValue: Number(row.total_value),
  }));
}

// O-05 (AMBER): any technician outside the configured band on average ticket
// (SPEC-BI-001 Section 5.2 - technician performance outlier). The band is
// +/- DETECT_O05_AVG_TICKET_BAND_PERCENT around the rest of the team's pooled
// average, with the technician themselves left out so one extreme performer
// can't drag the benchmark they're judged against. One finding per outlier.
// The spec's other two O-05 measures aren't evaluated yet: close rate needs
// ServiceTitan Estimates, hours efficiency needs Timesheets/payroll - neither
// is ingested.
export async function evaluateTechnicianOutlier(window: DetectionWindow, database: Knex = db): Promise<DetectedAlertFinding[]> {
  const technicians = (await technicianTicketsForWindow(database, window.periodStart, window.periodEnd))
    .filter((tech) => tech.jobCount >= env.DETECT_O05_MIN_JOBS_PER_TECHNICIAN);
  if (technicians.length < env.DETECT_O05_MIN_TECHNICIANS) return [];

  const teamJobCount = technicians.reduce((sum, tech) => sum + tech.jobCount, 0);
  const teamTotalValue = technicians.reduce((sum, tech) => sum + tech.totalValue, 0);
  const band = env.DETECT_O05_AVG_TICKET_BAND_PERCENT;

  const findings: DetectedAlertFinding[] = [];
  for (const tech of technicians) {
    const peerJobCount = teamJobCount - tech.jobCount;
    const peerTotalValue = teamTotalValue - tech.totalValue;
    const peerAverageTicket = peerTotalValue / peerJobCount;
    if (peerAverageTicket <= 0) continue;

    const averageTicket = tech.totalValue / tech.jobCount;
    const deviationPercent = ((averageTicket - peerAverageTicket) / peerAverageTicket) * 100;
    if (Math.abs(deviationPercent) < band) continue;

    findings.push({
      ruleCode: 'O-05',
      dimension: `${tech.technicianName ?? 'Technician'} (#${tech.technicianId})`,
      periodStart: window.periodStart,
      periodEnd: window.periodEnd,
      baselineStart: null,
      baselineEnd: null,
      metricValue: averageTicket,
      baselineValue: peerAverageTicket,
      details: {
        measure: 'AVERAGE_TICKET',
        direction: deviationPercent < 0 ? 'BELOW_BAND' : 'ABOVE_BAND',
        technicianId: tech.technicianId,
        technicianName: tech.technicianName,
        completedJobs: tech.jobCount,
        completedJobsValue: tech.totalValue,
        peerTechnicians: technicians.length - 1,
        peerCompletedJobs: peerJobCount,
        peerCompletedJobsValue: peerTotalValue,
        deviationPercent,
        bandPercent: band,
      },
    });
  }
  return findings;
}
