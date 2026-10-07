import Link from "next/link";
import { Suspense } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState, Skeleton } from "@/components/ui/States";
import { MetricTile, issueTone } from "@/components/sections/MetricTile";
import { DateRangePicker } from "@/components/filters/DateRangePicker";
import { DepartmentFilter } from "@/components/filters/DepartmentFilter";
import { getStJobsSummary, type StJobsSummary } from "@/lib/api/servicetitan";
import { rangeKey, type DateRange, type Department } from "@/lib/filters";
import { formatCount, formatMoney } from "@/lib/format";
import { CountList } from "./CountList";
import { LinkPending } from "@/components/ui/LinkPending";

/** URL param prefix for the jobs filters (`jobsFrom`, `jobsTo`, `jobsDept`). */
export const JOBS_FILTER_PREFIX = "jobs";

/** ServiceTitan jobs summary with date (default MTD) and optional department filters (default all). */
export function JobsSummary({ range, department }: { range: DateRange; department?: Department }) {
  return (
    <Card>
      <CardHeader
        title="Jobs"
        subtitle="ServiceTitan job pipeline"
        action={
          <Link
            href="/field-operations/jobs"
            className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-dark hover:underline"
          >
            View jobs
            <LinkPending className="h-3 w-3" />
          </Link>
        }
      />
      <div className="mb-5 flex flex-wrap items-center gap-2">
        <DepartmentFilter prefix={JOBS_FILTER_PREFIX} value={department} />
        <DateRangePicker prefix={JOBS_FILTER_PREFIX} range={range} />
      </div>
      <Suspense key={`${department ?? "all"}_${rangeKey(range)}`} fallback={<JobsSummarySkeleton />}>
        <JobsSummaryBody range={range} department={department} />
      </Suspense>
    </Card>
  );
}

async function JobsSummaryBody({ range, department }: { range: DateRange; department?: Department }) {
  let jobs: StJobsSummary;
  try {
    jobs = await getStJobsSummary({ ...range, department });
  } catch {
    return (
      <ErrorState
        title="Couldn't load jobs"
        description="The ServiceTitan reporting API didn't respond. Refresh the page to try again."
      />
    );
  }

  // All-zero is a legitimate response (e.g. nothing in the period, or backend reference data not yet synced).
  if (jobs.totalJobs === 0) {
    return (
      <EmptyState
        icon="filter"
        title="No data for this period/department"
        description="Try a different date range or department."
      />
    );
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 lg:col-span-2">
        <MetricTile label="Total Jobs" value={formatCount(jobs.totalJobs)} />
        <MetricTile label="Completed" value={formatCount(jobs.completedJobs)} />
        <MetricTile label="Completed (30d)" value={formatCount(jobs.completedLast30Days)} />
        <MetricTile label="Created (30d)" value={formatCount(jobs.createdLast30Days)} />
        <MetricTile label="Jobs Value" value={formatMoney(jobs.jobsTotalValue)} />
        <MetricTile label="Recalls" value={formatCount(jobs.recallJobs)} tone={issueTone(jobs.recallJobs)} />
        <MetricTile label="No-Charge Jobs" value={formatCount(jobs.noChargeJobs)} />
        <MetricTile
          label="Completed, Not Invoiced"
          value={formatCount(jobs.completedNotInvoiced)}
          tone={jobs.completedNotInvoiced > 0 ? "danger" : "success"}
          helpText="O-06"
        />
      </div>
      <div>
        <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">Jobs by status</h4>
        <CountList items={jobs.byStatus} />
      </div>
    </div>
  );
}

function JobsSummarySkeleton() {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <Skeleton key={i} className="h-[68px] rounded-xl" />
      ))}
    </div>
  );
}
