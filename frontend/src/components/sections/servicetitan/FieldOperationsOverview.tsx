import Link from "next/link";
import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState, SkeletonCard } from "@/components/ui/States";
import { MetricTile, issueTone } from "@/components/sections/MetricTile";
import { getServiceTitanSummary, type StArAgingBucketId, type StReportingSnapshot } from "@/lib/api/servicetitan";
import { formatCount, formatMoney } from "@/lib/format";
import { CountList } from "./CountList";
import { LinkPending } from "@/components/ui/LinkPending";

const agingLabels: Record<StArAgingBucketId, string> = {
  CURRENT: "Current",
  DAYS_1_30: "1–30 days",
  DAYS_31_60: "31–60 days",
  DAYS_61_90: "61–90 days",
  DAYS_90_PLUS: "90+ days",
};

const agingTone: Record<StArAgingBucketId, string> = {
  CURRENT: "text-foreground",
  DAYS_1_30: "text-foreground",
  DAYS_31_60: "text-warning",
  DAYS_61_90: "text-warning",
  DAYS_90_PLUS: "text-danger",
};

function DrillLink({ href, children }: { href: string; children: string }) {
  return (
    <Link href={href} className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-dark hover:underline">
      {children}
      <LinkPending className="h-3 w-3" />
    </Link>
  );
}

export async function FieldOperationsOverview() {
  let snapshot: StReportingSnapshot;
  try {
    snapshot = await getServiceTitanSummary();
  } catch {
    return (
      <ErrorState
        title="Couldn't load ServiceTitan data"
        description="The ServiceTitan reporting API didn't respond. Refresh the page to try again."
      />
    );
  }
  const { invoices, arAging, payments, leadsBookings, appointments, customers } = snapshot;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader
            title="Invoices"
            subtitle="ServiceTitan invoices"
            action={<DrillLink href="/field-operations/invoices">View invoices</DrillLink>}
          />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricTile label="Active Invoices" value={formatCount(invoices.totalActiveInvoices)} />
            <MetricTile label="Invoice Total" value={formatMoney(invoices.invoiceTotal)} />
            <MetricTile label="Outstanding" value={formatMoney(invoices.outstandingBalance)} />
            <MetricTile label="Paid" value={formatCount(invoices.paidCount)} tone="success" />
            <MetricTile label="Partially Paid" value={formatCount(invoices.partiallyPaidCount)} tone="warning" />
            <MetricTile label="Unpaid" value={formatCount(invoices.unpaidCount)} tone="danger" />
            <MetricTile label="Overdue" value={formatCount(invoices.overdueCount)} tone={issueTone(invoices.overdueCount)} />
            <MetricTile label="Invoiced (30d)" value={formatMoney(invoices.invoicedLast30Days)} />
            <MetricTile label="Sales Tax" value={formatMoney(invoices.totalSalesTax)} />
            <MetricTile label="Discount" value={formatMoney(invoices.totalDiscount)} />
          </div>
        </Card>

        <Card padded={false}>
          <div className="px-5 pt-5 sm:px-6 sm:pt-6">
            <CardHeader title="AR Aging" subtitle="Outstanding invoice balance by age" />
          </div>
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-y border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
                <th className="px-5 py-3 font-medium sm:px-6">Bucket</th>
                <th className="px-5 py-3 text-right font-medium sm:px-6">Invoices</th>
                <th className="px-5 py-3 text-right font-medium sm:px-6">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {arAging.map((row) => (
                <tr key={row.bucket}>
                  <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">{agingLabels[row.bucket] ?? row.bucket}</td>
                  <td className="px-5 py-3.5 text-right tabular-nums text-foreground/75 sm:px-6">{formatCount(row.invoiceCount)}</td>
                  <td className={`px-5 py-3.5 text-right font-medium tabular-nums sm:px-6 ${agingTone[row.bucket] ?? ""}`}>
                    {formatMoney(row.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Payments" subtitle="ServiceTitan payments received" />
          <div className="grid grid-cols-2 gap-3">
            <MetricTile label="Payments" value={formatCount(payments.paymentCount)} />
            <MetricTile label="Payment Total" value={formatMoney(payments.paymentTotal)} />
            <MetricTile label="Received (30d)" value={formatMoney(payments.receivedLast30Days)} />
            <MetricTile label="Unapplied" value={formatMoney(payments.unappliedTotal)} />
          </div>
          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-foreground/50">By payment type</h4>
          {payments.byType.length === 0 ? (
            <p className="text-xs text-foreground/45">No records</p>
          ) : (
            <ul className="divide-y divide-border-subtle text-sm">
              {payments.byType.map((t) => (
                <li key={t.label} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
                  <span className="text-foreground/70">{t.label}</span>
                  <span className="text-right tabular-nums">
                    <span className="font-medium text-foreground">{formatMoney(t.total)}</span>
                    <span className="ml-2 text-xs text-foreground/45">{formatCount(t.count)}</span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card>
          <CardHeader title="Leads & Bookings" subtitle="Inbound demand captured in ServiceTitan" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricTile label="Total Leads" value={formatCount(leadsBookings.totalLeads)} />
            <MetricTile label="Leads (30d)" value={formatCount(leadsBookings.leadsLast30Days)} />
            <MetricTile label="Total Bookings" value={formatCount(leadsBookings.totalBookings)} />
            <MetricTile label="Bookings (30d)" value={formatCount(leadsBookings.bookingsLast30Days)} />
            <MetricTile label="Converted to Job" value={formatCount(leadsBookings.bookingsConvertedToJob)} tone="success" />
          </div>
          <div className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-2">
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">Leads by status</h4>
              <CountList items={leadsBookings.leadsByStatus} />
            </div>
            <div>
              <h4 className="mb-2 text-xs font-semibold uppercase tracking-wide text-foreground/50">Bookings by status</h4>
              <CountList items={leadsBookings.bookingsByStatus} />
            </div>
          </div>
        </Card>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Appointments" subtitle="Scheduled field appointments" />
          <div className="grid grid-cols-3 gap-3">
            <MetricTile label="Total" value={formatCount(appointments.totalAppointments)} />
            <MetricTile label="Upcoming" value={formatCount(appointments.upcomingAppointments)} />
            <MetricTile
              label="Unconfirmed"
              value={formatCount(appointments.unconfirmedUpcoming)}
              tone={issueTone(appointments.unconfirmedUpcoming)}
              helpText="Upcoming"
            />
          </div>
          <h4 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-foreground/50">By status</h4>
          <CountList items={appointments.byStatus} />
        </Card>

        <Card>
          <CardHeader title="Customers" subtitle="ServiceTitan customer base" />
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <MetricTile label="Total Customers" value={formatCount(customers.totalCustomers)} />
            <MetricTile label="Active" value={formatCount(customers.activeCustomers)} />
            <MetricTile label="New (30d)" value={formatCount(customers.createdLast30Days)} />
            <MetricTile label="With Balance" value={formatCount(customers.customersWithBalance)} />
            <MetricTile label="Customer Balance" value={formatMoney(customers.totalCustomerBalance)} />
          </div>
        </Card>
      </div>
    </div>
  );
}

export function FieldOperationsSkeleton() {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
