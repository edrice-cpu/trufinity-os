import type { WorkItemWorkType, WorkItemWorkflowStatus, WorkItemSlaState } from "@/lib/api/google";

const workTypeStyles: Record<WorkItemWorkType, string> = {
  ESCALATION: "bg-danger-soft text-danger",
  REVIEW_REQUIRED: "bg-warning-soft text-warning",
};

const workTypeLabels: Record<WorkItemWorkType, string> = {
  ESCALATION: "Escalation",
  // Below the classifier confidence floor — review queue, never the brief (spec 6.3).
  REVIEW_REQUIRED: "Needs review",
};

const workflowStyles: Record<WorkItemWorkflowStatus, string> = {
  OPEN: "bg-danger-soft text-danger",
  ACKNOWLEDGED: "bg-info-soft text-info",
  RESOLVED: "bg-success-soft text-success",
  CLOSED: "bg-surface-muted text-foreground/60",
  NOT_A_PROBLEM: "bg-surface-muted text-foreground/60",
};

const workflowLabels: Record<WorkItemWorkflowStatus, string> = {
  OPEN: "Open",
  ACKNOWLEDGED: "Acknowledged",
  RESOLVED: "Resolved",
  CLOSED: "Closed",
  NOT_A_PROBLEM: "Not a problem",
};

const slaStyles: Record<WorkItemSlaState, string> = {
  ON_TRACK: "bg-success-soft text-success",
  BREACHED: "bg-danger-soft text-danger",
  MET: "bg-teal-light text-teal-dark",
  UNCONFIGURED: "bg-surface-muted text-foreground/45",
};

const slaLabels: Record<WorkItemSlaState, string> = {
  ON_TRACK: "On Track",
  BREACHED: "Breached",
  MET: "Met",
  UNCONFIGURED: "—",
};

const chip = "inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium";

export function WorkTypeBadge({ type }: { type: WorkItemWorkType }) {
  return <span className={`${chip} ${workTypeStyles[type]}`}>{workTypeLabels[type]}</span>;
}

export function WorkflowBadge({ status }: { status: WorkItemWorkflowStatus }) {
  return <span className={`${chip} ${workflowStyles[status]}`}>{workflowLabels[status]}</span>;
}

export function SlaBadge({ state }: { state: WorkItemSlaState }) {
  return <span className={`${chip} ${slaStyles[state]}`}>{slaLabels[state]}</span>;
}

export function ClassificationLabel({ label }: { label: string }) {
  const display = label
    .toLowerCase()
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span className="inline-flex items-center rounded-full bg-surface-muted px-2.5 py-1 text-xs font-medium text-foreground/70">
      {display}
    </span>
  );
}
