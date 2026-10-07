import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { ClosedLoopItem } from "@/lib/types";

// TODO: replace with closed-loop API data once available.
const closedLoop: ClosedLoopItem[] = [];

const typeMeta = {
  escalation: { label: "Escalation", icon: "alert-circle" },
  red_flag: { label: "Red Flag", icon: "flag" },
  opportunity: { label: "Opportunity", icon: "eye" },
} as const;

export default function ClosedLoopPage() {
  return (
    <div>
      <PageHeader
        title="Closed Loop"
        description="A record of resolved escalations, red flags, and opportunities — and how they were handled."
      />

      {!sectionReady.closedLoop ? (
        <PendingState />
      ) : (
      <Card padded={false}>
        <ol className="divide-y divide-border-subtle">
          {closedLoop.map((item) => {
            const meta = typeMeta[item.resolutionType];
            return (
              <li key={item.id} className="flex gap-4 px-5 py-4 sm:px-6">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
                  <Icon name="check-circle" className="h-4.5 w-4.5" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{item.title}</p>
                    <Pill>
                      <Icon name={meta.icon} className="mr-1 h-3 w-3" />
                      {meta.label}
                    </Pill>
                  </div>
                  <p className="mt-1 text-xs text-foreground/50">{item.customer}</p>
                  <p className="mt-2 text-sm text-foreground/70">{item.outcome}</p>
                  <p className="mt-2 text-xs text-foreground/40">
                    Closed {item.closedDate} by {item.resolvedBy}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
      </Card>
      )}
    </div>
  );
}
