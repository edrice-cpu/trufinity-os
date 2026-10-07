import { Suspense } from "react";
import { Card, CardHeader } from "@/components/ui/Card";
import { StatCard } from "@/components/ui/StatCard";
import { EmptyState, ErrorState, Skeleton, SkeletonCard } from "@/components/ui/States";
import { DateRangePicker } from "@/components/filters/DateRangePicker";
import { getInvoiceSummary, getPaymentSummary, type InvoiceSummary, type PaymentSummary } from "@/lib/api/reporting";
import { rangeKey, type DateRange } from "@/lib/filters";
import { formatCount, formatMoney } from "@/lib/format";
import { MetricTile, issueTone } from "./MetricTile";

/** URL param prefixes for each card's date filter (`invFrom`, `payTo`, ...). */
export const INVOICE_FILTER_PREFIX = "inv";
export const PAYMENT_FILTER_PREFIX = "pay";

/** QuickBooks invoice + payment KPIs, each with its own date filter (default month-to-date). */
export function FinancialOverview({ invoiceRange, paymentRange }: { invoiceRange: DateRange; paymentRange: DateRange }) {
  const invoiceKey = rangeKey(invoiceRange);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-foreground">Invoices</h2>
          <p className="mt-0.5 text-xs text-foreground/55">QuickBooks invoices in the selected period</p>
        </div>
        <DateRangePicker prefix={INVOICE_FILTER_PREFIX} range={invoiceRange} />
      </div>

      <Suspense key={invoiceKey} fallback={<FinancialOverviewSkeleton />}>
        <InvoiceStats range={invoiceRange} />
      </Suspense>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Invoice Status" subtitle="Active QuickBooks invoices by payment status" />
          <Suspense key={invoiceKey} fallback={<TilesSkeleton count={6} />}>
            <InvoiceStatus range={invoiceRange} />
          </Suspense>
        </Card>

        <Card>
          <CardHeader
            title="Payments"
            subtitle="QuickBooks payments, application and reconciliation"
            action={<DateRangePicker prefix={PAYMENT_FILTER_PREFIX} range={paymentRange} />}
          />
          <Suspense key={rangeKey(paymentRange)} fallback={<TilesSkeleton count={8} />}>
            <PaymentTiles range={paymentRange} />
          </Suspense>
        </Card>
      </div>
    </div>
  );
}

async function loadInvoices(range: DateRange): Promise<InvoiceSummary | null> {
  try {
    return await getInvoiceSummary(range);
  } catch {
    return null;
  }
}

async function InvoiceStats({ range }: { range: DateRange }) {
  const invoices = await loadInvoices(range);
  if (!invoices) {
    return (
      <ErrorState
        title="Couldn't load invoices"
        description="The QuickBooks reporting API didn't respond. Refresh the page to try again."
      />
    );
  }
  if (invoices.totalActiveInvoices === 0) {
    return <EmptyState icon="filter" title="No invoices for this period" description="Try a different date range." />;
  }

  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
      <StatCard metric={{ id: "active", label: "Active Invoices", value: formatCount(invoices.totalActiveInvoices) }} />
      <StatCard metric={{ id: "total", label: "Invoice Total", value: formatMoney(invoices.invoiceTotal) }} />
      <StatCard metric={{ id: "ar", label: "Outstanding AR", value: formatMoney(invoices.outstandingAr) }} />
      <StatCard metric={{ id: "tax", label: "Total Tax", value: formatMoney(invoices.totalTax) }} />
      <StatCard metric={{ id: "discount", label: "Total Discount", value: formatMoney(invoices.totalDiscount) }} />
    </div>
  );
}

async function InvoiceStatus({ range }: { range: DateRange }) {
  // Same memoized request as InvoiceStats; its error/empty message is shown above, so stay quiet here.
  const invoices = await loadInvoices(range);
  if (!invoices || invoices.totalActiveInvoices === 0) {
    return <p className="text-xs text-foreground/45">No data for this period</p>;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <MetricTile label="Paid" value={formatCount(invoices.paidCount)} tone="success" />
      <MetricTile label="Partially Paid" value={formatCount(invoices.partiallyPaidCount)} tone="warning" />
      <MetricTile label="Unpaid" value={formatCount(invoices.unpaidCount)} tone="danger" />
      <MetricTile label="Zero Value" value={formatCount(invoices.zeroValueCount)} />
      <MetricTile label="Unsupported" value={formatCount(invoices.unsupportedCount)} />
      <MetricTile
        label="Broken Links"
        value={formatCount(invoices.brokenTargetCount)}
        tone={issueTone(invoices.brokenTargetCount)}
      />
    </div>
  );
}

async function PaymentTiles({ range }: { range: DateRange }) {
  let payments: PaymentSummary;
  try {
    payments = await getPaymentSummary(range);
  } catch {
    return <ErrorState title="Couldn't load payments" />;
  }
  if (payments.paymentCount === 0) {
    return <EmptyState icon="filter" title="No payments for this period" description="Try a different date range." />;
  }

  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <MetricTile label="Payments" value={formatCount(payments.paymentCount)} />
      <MetricTile label="Payment Total" value={formatMoney(payments.paymentTotal)} />
      <MetricTile label="Applied to Invoices" value={formatMoney(payments.mappedApplicationTotal)} />
      <MetricTile label="Unapplied" value={formatMoney(payments.unappliedTotal)} />
      <MetricTile label="Reconciled" value={formatCount(payments.reconciledPaymentCount)} tone="success" />
      <MetricTile
        label="Unreconciled"
        value={formatCount(payments.unreconciledPaymentCount)}
        tone={issueTone(payments.unreconciledPaymentCount)}
      />
      <MetricTile label="Net Reconciliation Diff." value={formatMoney(payments.netReconciliationDifference)} />
      <MetricTile
        label="Without Invoice Link"
        value={formatCount(payments.paymentsWithoutInvoiceApplications)}
        tone={issueTone(payments.paymentsWithoutInvoiceApplications)}
      />
    </div>
  );
}

export function TilesSkeleton({ count }: { count: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
      {Array.from({ length: count }).map((_, i) => (
        <Skeleton key={i} className="h-[68px] rounded-xl" />
      ))}
    </div>
  );
}

export function FinancialOverviewSkeleton() {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
      {Array.from({ length: 5 }).map((_, i) => (
        <SkeletonCard key={i} />
      ))}
    </div>
  );
}
