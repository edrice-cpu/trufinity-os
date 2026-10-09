import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { ErrorState } from "@/components/ui/States";
import { WorkTypeBadge, WorkflowBadge, SlaBadge, ClassificationLabel } from "@/components/google/WorkItemBadges";
import { WorkItemActions } from "@/components/google/WorkItemActions";
import { getSessionToken } from "@/lib/auth/session";
import { getWorkItem } from "@/lib/api/google";
import { formatDateTime, formatEnumLabel, formatFraction } from "@/lib/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
      <dt className="w-48 shrink-0 text-xs font-medium uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="text-sm text-foreground/80">{children}</dd>
    </div>
  );
}

export default async function WorkItemDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/escalations");

  const result = await getWorkItem(token, id);

  if (result.kind === "unauthenticated") redirect("/login?next=/escalations");
  if (result.kind === "not_found") notFound();
  if (result.kind === "error") {
    return (
      <div className="mx-auto max-w-3xl">
        <Link href="/escalations" className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground/55 hover:text-foreground">
          <Icon name="arrow-left" className="h-4 w-4" />
          Back to Customer Escalations
        </Link>
        <ErrorState title="Couldn't load this work item" description={result.message} />
      </div>
    );
  }

  const item = result.data;
  const canAct = item.workflowStatus === "OPEN" || item.workflowStatus === "ACKNOWLEDGED";

  return (
    <div className="mx-auto max-w-3xl">
      <Link
        href="/escalations"
        className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground/55 hover:text-foreground"
      >
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to Customer Escalations
      </Link>

      <Card className="mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <WorkTypeBadge type={item.workType} />
              <WorkflowBadge status={item.workflowStatus} />
              <SlaBadge state={item.slaState} />
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <ClassificationLabel label={item.classificationLabel} />
              <span className="text-xs text-foreground/45">
                {formatFraction(item.confidence)} confidence
              </span>
            </div>
          </div>
          {canAct && (
            <div className="flex shrink-0 gap-2 self-start">
              <WorkItemActions item={item} />
            </div>
          )}
        </div>

        <p className="mt-3 text-sm text-foreground/70">
          <span className="font-medium text-foreground">Customer:</span>{" "}
          {item.customerDisplayName ?? <span className="text-foreground/45">No unique customer match for this sender</span>}
        </p>
        {item.senderFrom && (
          <p className="mt-1 text-sm text-foreground/70">
            <span className="font-medium text-foreground">From:</span> {item.senderFrom}
          </p>
        )}
        {item.reason && <p className="mt-3 text-sm leading-relaxed text-foreground/80">{item.reason}</p>}

        <div className="mt-4">
          <a
            href={item.sourceUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium text-foreground/70 hover:bg-surface-muted transition"
          >
            <Icon name="external-link" className="h-3.5 w-3.5" />
            Open original email in Gmail
            <span className="sr-only">(opens in a new tab)</span>
          </a>
          <p className="mt-1.5 text-xs text-foreground/40">
            Opens in the first signed-in Google account — sign in as {item.mailboxAddress} if the message isn&apos;t found.
          </p>
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="Work item" />
          <dl className="divide-y divide-border-subtle">
            <Row label="Type">{formatEnumLabel(item.workType)}</Row>
            <Row label="Workflow status">{formatEnumLabel(item.workflowStatus)}</Row>
            <Row label="SLA state">{formatEnumLabel(item.slaState)}</Row>
            <Row label="Customer">{item.customerDisplayName ?? "—"}</Row>
            <Row label="Mailbox">{item.mailboxAddress}</Row>
            {item.routedOwnerReference && (
              <Row label="Routed owner">{item.routedOwnerReference}</Row>
            )}
            <Row label="Created">{formatDateTime(item.createdAt)}</Row>
            {item.acknowledgedAt && (
              <Row label="Acknowledged">{formatDateTime(item.acknowledgedAt)}</Row>
            )}
            {item.resolvedAt && (
              <Row label="Resolved">{formatDateTime(item.resolvedAt)}</Row>
            )}
            {item.dismissedAt && (
              <Row label="Marked not a problem">{formatDateTime(item.dismissedAt)}</Row>
            )}
            {item.acknowledgementDeadline && (
              <Row label="Acknowledge by">{formatDateTime(item.acknowledgementDeadline)}</Row>
            )}
            {item.resolutionDeadline && (
              <Row label="Resolve by">{formatDateTime(item.resolutionDeadline)}</Row>
            )}
          </dl>
        </Card>

        <Card>
          <CardHeader
            title="Classification"
            subtitle="Classified from the message content, which is then discarded — never stored or shown here"
          />
          <dl className="divide-y divide-border-subtle">
            <Row label="Label">{formatEnumLabel(item.classificationLabel)}</Row>
            <Row label="Confidence">{formatFraction(item.confidence)}</Row>
            <Row label="Decision">{formatEnumLabel(item.decisionStatus)}</Row>
            <Row label="Classified at">{formatDateTime(item.classifiedAt)}</Row>
          </dl>
        </Card>
      </div>

      {item.dismissalReason && (
        <Card className="mt-6">
          <CardHeader title="Not-a-problem reason" />
          <p className="text-sm leading-relaxed text-foreground/75">{item.dismissalReason}</p>
        </Card>
      )}

      {item.resolutionNote && (
        <Card className="mt-6">
          <CardHeader title="Resolution note" />
          <p className="text-sm leading-relaxed text-foreground/75">{item.resolutionNote}</p>
        </Card>
      )}
    </div>
  );
}
