import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import { Pagination, listHref, lastPageOf } from "@/components/ui/Pagination";
import { WorkTypeBadge, WorkflowBadge, SlaBadge, ClassificationLabel } from "./WorkItemBadges";
import { WorkItemActions } from "./WorkItemActions";
import { formatDateTime } from "@/lib/format";
import type { WorkItem, WorkItemWorkType, WorkItemWorkflowStatus, WorkItemSlaState } from "@/lib/api/google";

const BASE_PATH = "/escalations";

type Query = Record<string, string | undefined>;

export function WorkItemTable({
  items,
  total,
  page,
  pageSize,
  query,
}: {
  items: WorkItem[];
  total: number;
  page: number;
  pageSize: number;
  query: Query;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon="check-circle"
        title="No work items match these filters"
        description="All clear — no escalations or review-required items found for the current selection."
      />
    );
  }

  const lastPage = lastPageOf(total, pageSize);

  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="border-b border-border-subtle bg-surface-muted/40">
              <th className="px-5 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Type</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Classification</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Status</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">SLA</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Sender</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Mailbox</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Classified</th>
              <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border-subtle">
            {items.map((item) => (
              <tr key={item.id} className="hover:bg-surface-muted/30 transition-colors">
                <td className="px-5 py-3.5">
                  <WorkTypeBadge type={item.workType} />
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex flex-col gap-1">
                    <ClassificationLabel label={item.classificationLabel} />
                    <span className="text-xs text-foreground/40">
                      {(item.confidence * 100).toFixed(0)}% conf.
                    </span>
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <WorkflowBadge status={item.workflowStatus} />
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex flex-col gap-1">
                    <SlaBadge state={item.slaState} />
                    {item.resolutionDeadline && item.workflowStatus !== "RESOLVED" && item.workflowStatus !== "CLOSED" && (
                      <span className="text-xs text-foreground/40">
                        Due {formatDateTime(item.resolutionDeadline)}
                      </span>
                    )}
                  </div>
                </td>
                <td className="px-4 py-3.5 max-w-[180px]">
                  <span className="block truncate text-xs text-foreground/70" title={item.senderFrom ?? undefined}>
                    {item.senderFrom ?? "—"}
                  </span>
                </td>
                <td className="px-4 py-3.5 max-w-[160px]">
                  <span className="block truncate text-xs text-foreground/70" title={item.mailboxAddress}>
                    {item.mailboxAddress}
                  </span>
                </td>
                <td className="px-4 py-3.5 whitespace-nowrap">
                  <span className="text-xs text-foreground/55">{formatDateTime(item.classifiedAt)}</span>
                </td>
                <td className="px-4 py-3.5">
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/escalations/${item.id}`}
                      className="inline-flex items-center gap-1 rounded-lg border border-border-subtle px-2.5 py-1 text-xs font-medium text-foreground/70 hover:bg-surface-muted transition"
                    >
                      <Icon name="eye" className="h-3.5 w-3.5" />
                      View
                    </Link>
                    <WorkItemActions item={item} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {total > pageSize && (
        <Pagination
          basePath={BASE_PATH}
          query={query}
          page={page}
          pageSize={pageSize}
          totalCount={total}
        />
      )}
    </div>
  );
}

export function WorkItemFilterChips({
  query,
  workType,
  workflowStatus,
  slaState,
}: {
  query: Query;
  workType?: WorkItemWorkType;
  workflowStatus?: WorkItemWorkflowStatus;
  slaState?: WorkItemSlaState;
}) {
  const chip = (
    param: string,
    value: string | undefined,
    label: string,
    active: string | undefined,
  ) => {
    const isActive = active === value;
    const next = isActive ? { ...query, [param]: undefined } : { ...query, [param]: value };
    return (
      <Link
        key={`${param}-${value ?? "all"}`}
        href={listHref(BASE_PATH, next)}
        aria-current={isActive ? "true" : undefined}
        className={`inline-flex items-center rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
          isActive ? "bg-ink text-white" : "bg-surface-muted text-foreground/60 hover:bg-surface-muted/70"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="mb-5 flex flex-wrap gap-3">
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by type">
        {chip("work_type", "ESCALATION", "Escalations", workType)}
        {chip("work_type", "REVIEW_REQUIRED", "Review Required", workType)}
      </div>
      <div className="h-4 w-px self-center bg-border-subtle" aria-hidden="true" />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
        {chip("workflow_status", "OPEN", "Open", workflowStatus)}
        {chip("workflow_status", "ACKNOWLEDGED", "Acknowledged", workflowStatus)}
        {chip("workflow_status", "RESOLVED", "Resolved", workflowStatus)}
      </div>
      <div className="h-4 w-px self-center bg-border-subtle" aria-hidden="true" />
      <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by SLA">
        {chip("sla_state", "BREACHED", "SLA Breached", slaState)}
        {chip("sla_state", "ON_TRACK", "SLA On Track", slaState)}
        {chip("sla_state", "MET", "SLA Met", slaState)}
      </div>
    </div>
  );
}
