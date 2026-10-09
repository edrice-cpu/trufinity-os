import "server-only";
import { backendFetch } from "@/lib/auth/backend";

export type WorkItemWorkType = "ESCALATION" | "REVIEW_REQUIRED";
/** NOT_A_PROBLEM = dismissed via the one-tap "not a problem" feedback (spec 6.4); terminal like RESOLVED. */
export type WorkItemWorkflowStatus = "OPEN" | "ACKNOWLEDGED" | "RESOLVED" | "CLOSED" | "NOT_A_PROBLEM";
export type WorkItemSlaState = "UNCONFIGURED" | "ON_TRACK" | "BREACHED" | "MET";

export interface WorkItem {
  id: string;
  workType: WorkItemWorkType;
  workflowStatus: WorkItemWorkflowStatus;
  slaState: WorkItemSlaState;
  mailboxAddress: string;
  providerMessageId: string;
  sourceUrl: string;
  routedOwnerReference: string | null;
  resolutionDeadline: string | null;
  acknowledgementDeadline: string | null;
  acknowledgedAt: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  dismissedAt: string | null;
  dismissedByUserId: string | null;
  dismissalReason: string | null;
  /** Set only when exactly one customer matched the sender email; otherwise null. */
  unifiedCustomerId: string | null;
  customerDisplayName: string | null;
  createdAt: string;
  updatedAt: string;
  classificationId: string;
  classificationLabel: string;
  confidence: number;
  reason: string;
  decisionStatus: string;
  classifiedAt: string;
  senderFrom: string | null;
}

/** acknowledged / resolved / breached count both work types; escalation + reviewRequired split the open items. */
export interface WorkItemStats {
  totalOpen: number;
  escalation: number;
  reviewRequired: number;
  acknowledged: number;
  resolved: number;
  breached: number;
}

export interface WorkItemListResult {
  items: WorkItem[];
  total: number;
  page: number;
  pageSize: number;
}

export interface WorkItemListFilters {
  work_type?: WorkItemWorkType;
  workflow_status?: WorkItemWorkflowStatus;
  mailbox_address?: string;
  sla_state?: WorkItemSlaState;
  page?: number;
  pageSize?: number;
}

export type WorkItemResult =
  | { kind: "ok"; data: WorkItem }
  | { kind: "not_found" }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

export type WorkItemListFetchResult =
  | { kind: "ok"; data: WorkItemListResult }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

export type WorkItemStatsFetchResult =
  | { kind: "ok"; data: WorkItemStats }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

function buildQuery(filters: WorkItemListFilters): string {
  const params = new URLSearchParams();
  if (filters.work_type) params.set("work_type", filters.work_type);
  if (filters.workflow_status) params.set("workflow_status", filters.workflow_status);
  if (filters.mailbox_address) params.set("mailbox_address", filters.mailbox_address);
  if (filters.sla_state) params.set("sla_state", filters.sla_state);
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.pageSize) params.set("pageSize", String(filters.pageSize));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export async function getWorkItemStats(token: string): Promise<WorkItemStatsFetchResult> {
  try {
    const response = await backendFetch<{ data: WorkItemStats }>("/api/google/work-items/stats", { token });
    if (response.status === 401) return { kind: "unauthenticated" };
    if (!response.ok || !response.data?.data) return { kind: "error", message: "Failed to load stats." };
    return { kind: "ok", data: response.data.data };
  } catch {
    return { kind: "error", message: "Unable to reach the backend." };
  }
}

export async function listWorkItems(token: string, filters: WorkItemListFilters = {}): Promise<WorkItemListFetchResult> {
  try {
    const response = await backendFetch<{ data: WorkItemListResult }>(`/api/google/work-items${buildQuery(filters)}`, { token });
    if (response.status === 401) return { kind: "unauthenticated" };
    if (!response.ok || !response.data?.data) return { kind: "error", message: "Failed to load work items." };
    return { kind: "ok", data: response.data.data };
  } catch {
    return { kind: "error", message: "Unable to reach the backend." };
  }
}

export async function getWorkItem(token: string, id: string): Promise<WorkItemResult> {
  try {
    const response = await backendFetch<{ data: WorkItem }>(`/api/google/work-items/${encodeURIComponent(id)}`, { token });
    if (response.status === 401) return { kind: "unauthenticated" };
    if (response.status === 404) return { kind: "not_found" };
    if (!response.ok || !response.data?.data) return { kind: "error", message: "Failed to load work item." };
    return { kind: "ok", data: response.data.data };
  } catch {
    return { kind: "error", message: "Unable to reach the backend." };
  }
}
