"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import type { FlagStatus, FlaggedItem } from "@/lib/types";
import { PriorityBadge, StatusBadge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";

const statusFilters: { value: FlagStatus | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "open", label: "Open" },
  { value: "in_progress", label: "In Progress" },
  { value: "resolved", label: "Resolved" },
];

export function FlaggedTable({ items }: { items: FlaggedItem[] }) {
  const [statusFilter, setStatusFilter] = useState<FlagStatus | "all">("all");

  const filtered = useMemo(
    () => (statusFilter === "all" ? items : items.filter((item) => item.status === statusFilter)),
    [items, statusFilter],
  );

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        {statusFilters.map((f) => (
          <button
            key={f.value}
            onClick={() => setStatusFilter(f.value)}
            className={`rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
              statusFilter === f.value
                ? "bg-ink text-white"
                : "bg-surface-muted text-foreground/60 hover:bg-surface-muted/70"
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <EmptyState
          icon="filter"
          title="No items match this filter"
          description="Try a different status filter, or check back after the next sync."
        />
      ) : (
        <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-left text-sm">
              <thead>
                <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
                  <th className="px-5 py-3 font-medium sm:px-6">Item</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Customer</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Source</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Priority</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                  <th className="px-5 py-3 font-medium sm:px-6">Reported</th>
                  <th className="px-5 py-3" />
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {filtered.map((item) => (
                  <tr key={item.id} className="group">
                    <td className="px-5 py-3.5 sm:px-6">
                      <Link href={`/flagged/${item.id}`} className="font-medium text-foreground group-hover:text-teal-dark">
                        {item.title}
                      </Link>
                      {(item.jobNumber || item.invoiceNumber) && (
                        <p className="mt-0.5 text-xs text-foreground/45">{item.jobNumber ?? item.invoiceNumber}</p>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-foreground/75 sm:px-6">{item.customer}</td>
                    <td className="px-5 py-3.5 text-foreground/55 sm:px-6">{item.source}</td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <PriorityBadge priority={item.priority} />
                    </td>
                    <td className="px-5 py-3.5 sm:px-6">
                      <StatusBadge status={item.status} />
                    </td>
                    <td className="px-5 py-3.5 whitespace-nowrap text-foreground/50 sm:px-6">{item.createdAt}</td>
                    <td className="px-5 py-3.5 text-right sm:px-6">
                      <Link href={`/flagged/${item.id}`} className="inline-flex items-center gap-1 text-xs font-medium text-teal-dark hover:underline">
                        Details
                        <Icon name="chevron-right" className="h-3.5 w-3.5" />
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
