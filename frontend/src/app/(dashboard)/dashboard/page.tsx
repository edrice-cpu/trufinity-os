import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import {
  FinancialOverview,
  INVOICE_FILTER_PREFIX,
  PAYMENT_FILTER_PREFIX,
} from "@/components/sections/FinancialOverview";
import { ALERTS_FILTER_PREFIX, DemandAlerts, DemandAlertsSkeleton } from "@/components/sections/DemandAlerts";
import { DateRangePicker } from "@/components/filters/DateRangePicker";
import { rangeKey, readDateRange } from "@/lib/filters";
import { FieldOperationsSnapshot } from "@/components/sections/servicetitan/FieldOperationsSnapshot";
import { SkeletonCard } from "@/components/ui/States";
import { Card, CardHeader } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { PriorityBadge } from "@/components/ui/Badge";
import { PendingState } from "@/components/ui/States";
import { companyMeta } from "@/lib/company";
import { formatReportDate } from "@/lib/format";
import { sectionReady } from "@/lib/sections";
import type { FlaggedItem } from "@/lib/types";

// TODO: replace with alerts API data once available.
const flaggedItems: FlaggedItem[] = [];

const quickLinks = [
  { href: "/daily-brief", label: "Daily Executive Brief", description: "Today's brief in the fixed spec section order", icon: "sun" },
  { href: "/demand-alerts", label: "Demand Alerts", description: "Booking-rate declines & objection spikes", icon: "bell" },
  { href: "/financial-alerts", label: "Financial Alerts", description: "AR aging, concentration, discounts, credit memos & revenue gaps", icon: "alert-circle" },
  { href: "/field-operations", label: "Field Operations", description: "ServiceTitan jobs, invoices, AR aging & schedule", icon: "building" },
  { href: "/scorecard", label: "Scorecard", description: "KPIs vs. targets across the business", icon: "bar-chart" },
  { href: "/escalations", label: "Customer Escalations", description: "Problem emails, calls & reviews", icon: "alert-circle" },
  { href: "/red-flags", label: "Red Flags", description: "RED exceptions ranked by dollar impact", icon: "flag" },
  { href: "/responsiveness", label: "Responsiveness", description: "Phone, AI call agent & email response times", icon: "clock" },
  { href: "/marketing", label: "Marketing", description: "Google Ads & reputation performance", icon: "megaphone" },
  { href: "/watchlist", label: "Watch List & Opportunities", description: "AMBER watch items & BLUE opportunities", icon: "eye" },
  { href: "/closed-loop", label: "Closed Loop", description: "Recently resolved items", icon: "check-circle" },
  { href: "/data-quality", label: "Data Quality", description: "QuickBooks sync health & integrity", icon: "wrench" },
] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const sp = await searchParams;
  const alertsRange = readDateRange(sp, ALERTS_FILTER_PREFIX);
  const topAlerts = flaggedItems.filter((item) => item.status === "open" || item.status === "in_progress").slice(0, 4);

  return (
    <div>
      <PageHeader
        title={`Good morning, Daniel`}
        description={`Here's how ${companyMeta.shortName} is performing — ${formatReportDate()}.`}
        action={
          <Link
            href="/daily-brief"
            className="inline-flex items-center gap-1.5 rounded-lg bg-brand px-3.5 py-2 text-xs font-semibold text-white transition hover:bg-brand-dark"
          >
            View Executive Brief
            <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </Link>
        }
      />

      <FinancialOverview
        invoiceRange={readDateRange(sp, INVOICE_FILTER_PREFIX)}
        paymentRange={readDateRange(sp, PAYMENT_FILTER_PREFIX)}
      />

      <div className="mt-6">
        <Suspense fallback={<SkeletonCard />}>
          <FieldOperationsSnapshot />
        </Suspense>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Card>
            <CardHeader
              title="Needs your attention"
              subtitle="Open escalations and red flags across the business"
              action={
                <Link href="/red-flags" className="text-xs font-medium text-teal-dark hover:underline">
                  View all
                </Link>
              }
            />
            {!(sectionReady.escalations || sectionReady.redFlags) ? (
              <PendingState />
            ) : (
            <div className="divide-y divide-border-subtle">
              {topAlerts.map((item) => (
                <Link
                  key={item.id}
                  href={`/flagged/${item.id}`}
                  className="flex items-center gap-4 py-3.5 first:pt-0 last:pb-0 hover:opacity-80"
                >
                  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-surface-muted text-foreground/50">
                    <Icon name={item.type === "escalation" ? "alert-circle" : "flag"} className="h-4 w-4" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{item.title}</p>
                    <p className="truncate text-xs text-foreground/50">{item.customer} &middot; {item.source}</p>
                  </div>
                  <PriorityBadge priority={item.priority} />
                  <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-foreground/30" />
                </Link>
              ))}
            </div>
            )}
          </Card>
        </div>

        <Card>
          <CardHeader
            title="Demand Alerts"
            subtitle="D-series booking & objection exceptions"
            action={
              <Link href="/demand-alerts" className="text-xs font-medium text-teal-dark hover:underline">
                View all
              </Link>
            }
          />
          <div className="mb-4">
            <DateRangePicker prefix={ALERTS_FILTER_PREFIX} range={alertsRange} />
          </div>
          <Suspense key={rangeKey(alertsRange)} fallback={<DemandAlertsSkeleton />}>
            <DemandAlerts limit={3} range={alertsRange} />
          </Suspense>
        </Card>
      </div>

      <div className="mt-6">
        <h2 className="mb-3 text-sm font-semibold text-foreground">Explore reports</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {quickLinks.map((link) => (
            <Link key={link.href} href={link.href}>
              <Card className="flex h-full flex-col gap-3 transition hover:border-teal-dark/40 hover:shadow-md">
                <span className="flex h-9 w-9 items-center justify-center rounded-lg bg-teal-light text-teal-dark">
                  <Icon name={link.icon} className="h-4.5 w-4.5" />
                </span>
                <div>
                  <p className="text-sm font-semibold text-foreground">{link.label}</p>
                  <p className="mt-1 text-xs text-foreground/55">{link.description}</p>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
