import type { ReactNode } from "react";
import type { FlagStatus, Priority } from "@/lib/types";

const priorityStyles: Record<Priority, string> = {
  critical: "bg-danger-soft text-danger",
  high: "bg-warning-soft text-warning",
  medium: "bg-info-soft text-info",
  low: "bg-surface-muted text-foreground/60",
};

const statusStyles: Record<FlagStatus, string> = {
  open: "bg-danger-soft text-danger",
  in_progress: "bg-warning-soft text-warning",
  resolved: "bg-success-soft text-success",
  closed: "bg-surface-muted text-foreground/60",
};

const statusLabels: Record<FlagStatus, string> = {
  open: "Open",
  in_progress: "In Progress",
  resolved: "Resolved",
  closed: "Closed",
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium capitalize ${priorityStyles[priority]}`}
    >
      {priority}
    </span>
  );
}

export function StatusBadge({ status }: { status: FlagStatus }) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${statusStyles[status]}`}
    >
      {statusLabels[status]}
    </span>
  );
}

const scoreStyles: Record<string, string> = {
  on_track: "bg-success-soft text-success",
  at_risk: "bg-warning-soft text-warning",
  off_track: "bg-danger-soft text-danger",
};

const scoreLabels: Record<string, string> = {
  on_track: "On Track",
  at_risk: "At Risk",
  off_track: "Off Track",
};

export function StatusPill({ status }: { status: "on_track" | "at_risk" | "off_track" }) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-medium ${scoreStyles[status]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {scoreLabels[status]}
    </span>
  );
}

export function Pill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "brand" | "teal" }) {
  const toneStyles = {
    neutral: "bg-surface-muted text-foreground/70",
    brand: "bg-brand-light text-brand-dark",
    teal: "bg-teal-light text-teal-dark",
  }[tone];
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${toneStyles}`}>
      {children}
    </span>
  );
}
