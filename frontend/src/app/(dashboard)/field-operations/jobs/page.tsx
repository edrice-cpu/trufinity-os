import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, ErrorState, Skeleton, SkeletonTable } from "@/components/ui/States";
import { FilterChips, PageOutOfRange, Pagination, lastPageOf } from "@/components/ui/Pagination";
import {
  getStJobsSummary,
  listStJobs,
  ST_MAX_PAGE_SIZE,
  type CountByLabel,
  type StJobListItem,
} from "@/lib/api/servicetitan";
import { ALL_TIME_RANGE, firstParam, readPage, type SearchParams } from "@/lib/filters";
import type { Paginated } from "@/lib/api/client";
import { formatDate, formatEnumLabel, formatMoney } from "@/lib/format";

const PAGE_SIZE = Math.min(25, ST_MAX_PAGE_SIZE);
const BASE_PATH = "/field-operations/jobs";

export default async function StJobsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const status = firstParam(sp.status) || undefined;
  const page = readPage(sp);

  return (
    <div>
      <Link href="/field-operations" className="mb-3 inline-flex items-center gap-1 text-xs font-medium text-foreground/55 hover:text-foreground">
        <Icon name="arrow-left" className="h-3.5 w-3.5" /> Field Operations
      </Link>
      <PageHeader title="Jobs" description="ServiceTitan jobs, newest first. Filter by status to drill down." />

      {/* Chips and table load independently, so a slow summary never holds up the list. */}
      <Suspense fallback={<Skeleton className="mb-5 h-8 w-80 rounded-full" />}>
        <StatusChips status={status} />
      </Suspense>

      <Suspense key={`${status ?? "all"}_${page}`} fallback={<SkeletonTable rows={8} />}>
        <JobsResults status={status} page={page} />
      </Suspense>
    </div>
  );
}

async function StatusChips({ status }: { status?: string }) {
  let statuses: CountByLabel[];
  try {
    // All-time: the list below isn't date-filtered, so chips mustn't follow the MTD default.
    statuses = (await getStJobsSummary(ALL_TIME_RANGE)).byStatus;
  } catch {
    statuses = [];
  }
  // Keep the active status selectable even if the summary didn't return it.
  if (status && !statuses.some((s) => s.label === status)) statuses = [...statuses, { label: status, count: 0 }];
  if (statuses.length === 0) return null;

  return (
    <FilterChips
      basePath={BASE_PATH}
      param="status"
      active={status}
      options={statuses.map((s) => ({ value: s.label, label: formatEnumLabel(s.label) }))}
    />
  );
}

async function JobsResults({ status, page }: { status?: string; page: number }) {
  let result: Paginated<StJobListItem>;
  try {
    result = await listStJobs({ page, pageSize: PAGE_SIZE, status });
  } catch {
    return <ErrorState title="Couldn't load jobs" />;
  }
  const lastPage = lastPageOf(result.totalCount, result.pageSize);
  if (result.data.length === 0 && result.totalCount > 0 && page > lastPage) {
    return <PageOutOfRange basePath={BASE_PATH} query={{ status }} lastPage={lastPage} />;
  }
  return <JobsTable result={result} status={status} />;
}

function JobsTable({ result, status }: { result: Paginated<StJobListItem>; status?: string }) {
  if (result.data.length === 0) {
    return <EmptyState title="No jobs found" description={status ? `No jobs with status “${formatEnumLabel(status)}”.` : undefined} />;
  }
  return (
    <Card padded={false}>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-left text-sm">
          <thead>
            <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
              <th className="px-5 py-3 font-medium sm:px-6">Job #</th>
              <th className="px-5 py-3 font-medium sm:px-6">Status</th>
              <th className="px-5 py-3 font-medium sm:px-6">Customer</th>
              <th className="px-5 py-3 font-medium sm:px-6">Created</th>
              <th className="px-5 py-3 font-medium sm:px-6">Completed</th>
              <th className="px-5 py-3 font-medium sm:px-6">Invoice</th>
              <th className="px-5 py-3 text-right font-medium sm:px-6">Total</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {result.data.map((job) => (
              <tr key={job.id}>
                <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {job.jobNumber ?? job.id}
                    {job.isRecall && <Pill tone="brand">Recall</Pill>}
                    {job.noCharge && <Pill>No charge</Pill>}
                  </div>
                </td>
                <td className="px-5 py-3.5 text-foreground/70 sm:px-6">{formatEnumLabel(job.status)}</td>
                <td className="px-5 py-3.5 text-foreground/60 sm:px-6">{job.customerId ?? "—"}</td>
                <td className="px-5 py-3.5 text-foreground/60 sm:px-6">{formatDate(job.createdOn)}</td>
                <td className="px-5 py-3.5 text-foreground/60 sm:px-6">{formatDate(job.completedOn)}</td>
                <td className="px-5 py-3.5 sm:px-6">
                  {job.invoiceId ? (
                    <span className="text-foreground/60">{job.invoiceId}</span>
                  ) : job.completedOn ? (
                    <span className="text-xs font-medium text-danger">Not invoiced</span>
                  ) : (
                    <span className="text-foreground/40">—</span>
                  )}
                </td>
                <td className="px-5 py-3.5 text-right font-medium tabular-nums text-foreground sm:px-6">{formatMoney(job.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Pagination
        basePath={BASE_PATH}
        query={{ status }}
        page={result.page}
        pageSize={result.pageSize}
        totalCount={result.totalCount}
      />
    </Card>
  );
}
