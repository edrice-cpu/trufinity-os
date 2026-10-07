import Link from "next/link";
import { Suspense, type ReactNode } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Icon } from "@/components/ui/Icon";
import { PendingState, SkeletonTable } from "@/components/ui/States";
import { SyncStatusPanel } from "@/components/sections/servicetitan/SyncStatusPanel";
import { companyMeta } from "@/lib/company";
import { formatReportDate } from "@/lib/format";
import { sectionReady, type SectionId } from "@/lib/sections";

// Fixed section order from spec Section 7 — do not reorder.
const briefSections: { id: SectionId; title: string; subtitle: string; href?: string }[] = [
  { id: "briefHeader", title: "Data Freshness", subtitle: "ServiceTitan last sync per entity and any failed runs" },
  { id: "scorecard", title: "Scorecard", subtitle: "Yesterday, week-to-date and month-to-date vs. prior period", href: "/scorecard" },
  { id: "escalations", title: "Customer Escalations", subtitle: "Problem emails, calls, reviews and silent-signal cases", href: "/escalations" },
  { id: "redFlags", title: "Red Flags", subtitle: "RED severity exceptions, ranked by dollar impact", href: "/red-flags" },
  { id: "responsiveness", title: "Responsiveness", subtitle: "Unanswered inbound messages and aging threads", href: "/responsiveness" },
  { id: "marketing", title: "Marketing", subtitle: "Cost per booked job and gross profit per ad dollar", href: "/marketing" },
  { id: "watchList", title: "Watch List", subtitle: "AMBER exceptions (top 10)", href: "/watchlist" },
  { id: "opportunities", title: "Opportunities", subtitle: "BLUE exceptions with estimated revenue value (top 5)", href: "/watchlist" },
  { id: "closedLoop", title: "Closed Loop", subtitle: "Resolved vs. still-open items, owner and SLA status", href: "/closed-loop" },
];

// Live content for sections whose APIs are wired; the rest fall back to a "View details" link.
const sectionContent: Partial<Record<SectionId, ReactNode>> = {
  briefHeader: (
    <Suspense fallback={<SkeletonTable rows={3} />}>
      <SyncStatusPanel />
    </Suspense>
  ),
};

export default function DailyBriefPage() {
  return (
    <div className="mx-auto max-w-4xl">
      <PageHeader
        title="Daily Executive Brief"
        description={`${formatReportDate()} · ${companyMeta.timezone} · ${companyMeta.shortName}`}
      />

      <div className="space-y-4">
        {briefSections.map((section) => (
          <details
            key={section.id}
            open
            className="group rounded-2xl border border-border-subtle bg-surface shadow-sm"
          >
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 sm:px-6">
              <div>
                <h3 className="text-sm font-semibold text-foreground">{section.title}</h3>
                <p className="mt-0.5 text-xs text-foreground/55">{section.subtitle}</p>
              </div>
              <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-foreground/30 transition group-open:rotate-90" />
            </summary>
            <div className="px-5 pb-5 sm:px-6 sm:pb-6">
              {!sectionReady[section.id] ? (
                <PendingState />
              ) : sectionContent[section.id] ? (
                sectionContent[section.id]
              ) : (
                section.href && (
                  <Link href={section.href} className="text-xs font-medium text-teal-dark hover:underline">
                    View details
                  </Link>
                )
              )}
            </div>
          </details>
        ))}
      </div>
    </div>
  );
}
