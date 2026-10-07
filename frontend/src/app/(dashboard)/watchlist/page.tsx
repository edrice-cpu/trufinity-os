"use client";

import { useMemo, useState } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { Pill } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { EmptyState, PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { WatchListItem } from "@/lib/types";

// TODO: replace with watch list (AMBER) and opportunities (BLUE) API data once available.
const watchList: WatchListItem[] = [];

const tabs: { value: WatchListItem["category"] | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "watch", label: "Watch" },
  { value: "opportunity", label: "Opportunities" },
];

export default function WatchListPage() {
  const [tab, setTab] = useState<WatchListItem["category"] | "all">("all");
  const items = useMemo(() => (tab === "all" ? watchList : watchList.filter((i) => i.category === tab)), [tab]);

  return (
    <div>
      <PageHeader
        title="Watch List & Opportunities"
        description="Accounts and situations worth keeping an eye on — including upsell and growth opportunities."
      />

      <div className="mb-5 flex gap-2">
        {tabs.map((t) => (
          <button
            key={t.value}
            onClick={() => setTab(t.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
              tab === t.value ? "bg-ink text-white" : "bg-surface-muted text-foreground/60 hover:bg-surface-muted/70"
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {!(tab === "opportunity" ? sectionReady.opportunities : tab === "watch" ? sectionReady.watchList : sectionReady.watchList && sectionReady.opportunities) ? (
        <PendingState />
      ) : items.length === 0 ? (
        <EmptyState title="Nothing here yet" description="Items will appear once flagged from a report or added manually." />
      ) : (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {items.map((item) => (
            <Card key={item.id} className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <Pill tone={item.category === "opportunity" ? "brand" : "teal"}>
                    {item.category === "opportunity" ? "Opportunity" : "Watch"}
                  </Pill>
                  <h3 className="mt-2 text-sm font-semibold text-foreground">{item.title}</h3>
                </div>
                {item.value && <span className="shrink-0 text-sm font-semibold text-foreground/80">{item.value}</span>}
              </div>
              <p className="text-sm leading-relaxed text-foreground/65">{item.note}</p>
              <div className="mt-auto flex items-center justify-between border-t border-border-subtle pt-3 text-xs text-foreground/50">
                <span className="flex items-center gap-1.5">
                  <Icon name="user" className="h-3.5 w-3.5" />
                  {item.owner}
                </span>
                {item.dueDate && (
                  <span className="flex items-center gap-1.5">
                    <Icon name="clock" className="h-3.5 w-3.5" />
                    {item.dueDate}
                  </span>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
