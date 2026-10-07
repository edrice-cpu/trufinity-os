import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { SkeletonTable } from "@/components/ui/States";
import {
  FieldOperationsOverview,
  FieldOperationsSkeleton,
} from "@/components/sections/servicetitan/FieldOperationsOverview";
import { TechnicianSummary } from "@/components/sections/servicetitan/TechnicianSummary";
import { JOBS_FILTER_PREFIX, JobsSummary } from "@/components/sections/servicetitan/JobsSummary";
import { readDateRange, readDepartment } from "@/lib/filters";

export default async function FieldOperationsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;

  return (
    <div>
      <PageHeader
        title="Field Operations"
        description="ServiceTitan jobs, invoices, AR aging, payments, demand and schedule."
      />
      <JobsSummary range={readDateRange(sp, JOBS_FILTER_PREFIX)} department={readDepartment(sp, JOBS_FILTER_PREFIX)} />
      <div className="mt-6">
        <Suspense fallback={<FieldOperationsSkeleton />}>
          <FieldOperationsOverview />
        </Suspense>
      </div>
      <div className="mt-6">
        <Suspense fallback={<SkeletonTable rows={4} />}>
          <TechnicianSummary />
        </Suspense>
      </div>
    </div>
  );
}
