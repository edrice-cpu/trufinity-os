import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";
import { MetricTile, issueTone } from "@/components/sections/MetricTile";
import { getServiceTitanSummary, type StReportingSnapshot } from "@/lib/api/servicetitan";
import { formatCount, formatMoney } from "@/lib/format";

/** Compact ServiceTitan KPIs for the main dashboard; full detail lives on /field-operations. */
export async function FieldOperationsSnapshot() {
  let snapshot: StReportingSnapshot;
  try {
    snapshot = await getServiceTitanSummary();
  } catch {
    return <ErrorState title="Couldn't load field operations" />;
  }
  const { jobs, invoices, appointments } = snapshot;

  return (
    <Card>
      <CardHeader
        title="Field Operations"
        subtitle="ServiceTitan jobs, invoices and schedule"
        action={
          <Link href="/field-operations" className="text-xs font-medium text-teal-dark hover:underline">
            View all
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        <MetricTile label="Completed (30d)" value={formatCount(jobs.completedLast30Days)} />
        <MetricTile
          label="Not Invoiced"
          value={formatCount(jobs.completedNotInvoiced)}
          tone={jobs.completedNotInvoiced > 0 ? "danger" : "success"}
          helpText="Completed jobs"
        />
        <MetricTile label="Recalls" value={formatCount(jobs.recallJobs)} tone={issueTone(jobs.recallJobs)} />
        <MetricTile label="ST Outstanding" value={formatMoney(invoices.outstandingBalance)} />
        <MetricTile label="Overdue Invoices" value={formatCount(invoices.overdueCount)} tone={issueTone(invoices.overdueCount)} />
        <MetricTile
          label="Upcoming Appts"
          value={formatCount(appointments.upcomingAppointments)}
          helpText={`${formatCount(appointments.unconfirmedUpcoming)} unconfirmed`}
        />
      </div>
    </Card>
  );
}
