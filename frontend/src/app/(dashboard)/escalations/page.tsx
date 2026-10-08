import { redirect } from "next/navigation";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { ErrorState } from "@/components/ui/States";
import { WorkItemTable, WorkItemFilterChips } from "@/components/google/WorkItemTable";
import { getSessionToken } from "@/lib/auth/session";
import { getWorkItemStats, listWorkItems } from "@/lib/api/google";
import { firstParam, readPage } from "@/lib/filters";
import { formatCount } from "@/lib/format";
import type { WorkItemWorkType, WorkItemWorkflowStatus, WorkItemSlaState } from "@/lib/api/google";
import type { SearchParams } from "@/lib/filters";

const WORK_TYPES = ["ESCALATION", "REVIEW_REQUIRED"] as const;
const WORKFLOW_STATUSES = ["OPEN", "ACKNOWLEDGED", "RESOLVED", "CLOSED"] as const;
const SLA_STATES = ["UNCONFIGURED", "ON_TRACK", "BREACHED", "MET"] as const;
const PAGE_SIZE = 25;

function readWorkType(sp: SearchParams): WorkItemWorkType | undefined {
  const v = firstParam(sp.work_type);
  return (WORK_TYPES as readonly string[]).includes(v ?? "") ? (v as WorkItemWorkType) : undefined;
}

function readWorkflowStatus(sp: SearchParams): WorkItemWorkflowStatus | undefined {
  const v = firstParam(sp.workflow_status);
  return (WORKFLOW_STATUSES as readonly string[]).includes(v ?? "") ? (v as WorkItemWorkflowStatus) : undefined;
}

function readSlaState(sp: SearchParams): WorkItemSlaState | undefined {
  const v = firstParam(sp.sla_state);
  return (SLA_STATES as readonly string[]).includes(v ?? "") ? (v as WorkItemSlaState) : undefined;
}

export default async function EscalationsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/escalations");

  const sp = await searchParams;
  const workType = readWorkType(sp);
  const workflowStatus = readWorkflowStatus(sp);
  const slaState = readSlaState(sp);
  const mailboxAddress = firstParam(sp.mailbox_address);
  const page = readPage(sp);

  const activeQuery: Record<string, string | undefined> = {
    ...(workType ? { work_type: workType } : {}),
    ...(workflowStatus ? { workflow_status: workflowStatus } : {}),
    ...(slaState ? { sla_state: slaState } : {}),
    ...(mailboxAddress ? { mailbox_address: mailboxAddress } : {}),
  };

  const [statsResult, listResult] = await Promise.all([
    getWorkItemStats(token),
    listWorkItems(token, {
      ...(workType ? { work_type: workType } : {}),
      ...(workflowStatus ? { workflow_status: workflowStatus } : {}),
      ...(slaState ? { sla_state: slaState } : {}),
      ...(mailboxAddress ? { mailbox_address: mailboxAddress } : {}),
      page,
      pageSize: PAGE_SIZE,
    }),
  ]);

  return (
    <div>
      <PageHeader
        title="Email Escalations"
        description="Actionable items detected by the Google Workspace email classifier — escalations and review-required messages across monitored mailboxes."
      />

      {statsResult.kind === "unauthenticated" && redirect("/login?next=/escalations")}

      {statsResult.kind === "ok" && (
        <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-6">
          <StatTile label="Open" value={statsResult.data.totalOpen} tone="danger" />
          <StatTile label="Escalations" value={statsResult.data.escalation} tone="danger" />
          <StatTile label="Review Required" value={statsResult.data.reviewRequired} tone="warning" />
          <StatTile label="Acknowledged" value={statsResult.data.acknowledged} tone="info" />
          <StatTile label="Resolved" value={statsResult.data.resolved} tone="success" />
          <StatTile label="SLA Breached" value={statsResult.data.breached} tone="danger" />
        </div>
      )}

      {statsResult.kind === "error" && (
        <Card className="mb-6">
          <ErrorState title="Couldn't load stats" description={statsResult.message} />
        </Card>
      )}

      <WorkItemFilterChips
        query={activeQuery}
        workType={workType}
        workflowStatus={workflowStatus}
        slaState={slaState}
      />

      {listResult.kind === "unauthenticated" && redirect("/login?next=/escalations")}

      {listResult.kind === "error" && (
        <ErrorState
          title="Couldn't load work items"
          description={listResult.message}
        />
      )}

      {listResult.kind === "ok" && (
        <WorkItemTable
          items={listResult.data.items}
          total={listResult.data.total}
          page={listResult.data.page}
          pageSize={listResult.data.pageSize}
          query={activeQuery}
        />
      )}
    </div>
  );
}

function StatTile({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: "danger" | "warning" | "info" | "success" | "neutral";
}) {
  const valueStyles: Record<string, string> = {
    danger: "text-danger",
    warning: "text-warning",
    info: "text-info",
    success: "text-success",
    neutral: "text-foreground",
  };
  return (
    <Card>
      <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">{label}</p>
      <p className={`mt-2 text-2xl font-semibold ${valueStyles[tone]}`}>{formatCount(value)}</p>
    </Card>
  );
}
