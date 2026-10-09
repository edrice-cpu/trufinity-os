import Link from "next/link";
import { EmptyState, ErrorState, SkeletonTable } from "@/components/ui/States";
import { Icon } from "@/components/ui/Icon";
import { ClassificationLabel, SlaBadge, WorkflowBadge } from "@/components/google/WorkItemBadges";
import { listWorkItems, type WorkItem } from "@/lib/api/google";
import { getSessionToken } from "@/lib/auth/session";
import { formatDateTime } from "@/lib/format";

/** Newest open (unclaimed or acknowledged) customer escalations. The review queue is excluded (spec 6.3). */
export async function OpenEscalations({ limit }: { limit: number }) {
  const token = await getSessionToken();
  if (!token) return <ErrorState title="Sign in to see customer escalations" />;

  const [open, acknowledged] = await Promise.all(
    (["OPEN", "ACKNOWLEDGED"] as const).map((workflow_status) =>
      listWorkItems(token, { work_type: "ESCALATION", workflow_status, pageSize: limit }),
    ),
  );
  if (open.kind !== "ok" || acknowledged.kind !== "ok") {
    return <ErrorState title="Couldn't load customer escalations" />;
  }

  const items: WorkItem[] = [...open.data.items, ...acknowledged.data.items]
    // Same order as the backend list (newest classification first).
    .sort((a, b) => b.classifiedAt.localeCompare(a.classifiedAt))
    .slice(0, limit);

  if (items.length === 0) {
    return (
      <EmptyState
        icon="check-circle"
        title="No open customer escalations"
        description="Nothing is waiting on the team right now."
      />
    );
  }

  return (
    <div className="divide-y divide-border-subtle">
      {items.map((item) => (
        <Link
          key={item.id}
          href={`/escalations/${item.id}`}
          className="flex items-center gap-4 py-3.5 first:pt-0 last:pb-0 hover:opacity-80"
        >
          <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-danger-soft text-danger">
            <Icon name="mail" className="h-4 w-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-medium text-foreground">
              {item.customerDisplayName ?? item.senderFrom ?? "Unknown sender"}
            </p>
            <p className="truncate text-xs text-foreground/50">
              {item.reason || item.mailboxAddress} &middot; {formatDateTime(item.classifiedAt)}
            </p>
          </div>
          <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
            <ClassificationLabel label={item.classificationLabel} />
            <WorkflowBadge status={item.workflowStatus} />
            {item.slaState === "BREACHED" && <SlaBadge state={item.slaState} />}
          </div>
          <Icon name="chevron-right" className="h-4 w-4 shrink-0 text-foreground/30" />
        </Link>
      ))}
    </div>
  );
}

export function OpenEscalationsSkeleton() {
  return <SkeletonTable rows={4} />;
}
