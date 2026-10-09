import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { EmptyState } from "@/components/ui/States";
import { Pagination, listHref } from "@/components/ui/Pagination";
import { WorkflowBadge, SlaBadge, ClassificationLabel } from "./WorkItemBadges";
import { WorkItemActions } from "./WorkItemActions";
import { formatDateTime, formatFraction } from "@/lib/format";
import type { WorkItem, WorkItemWorkType, WorkItemWorkflowStatus, WorkItemSlaState } from "@/lib/api/google";

const BASE_PATH = "/escalations";

type Query = Record<string, string | undefined>;

export function WorkItemTable({
  items,
  total,
  page,
  pageSize,
  query,
  workType,
}: {
  items: WorkItem[];
  total: number;
  page: number;
  pageSize: number;
  query: Query;
  workType: WorkItemWorkType;
}) {
  if (items.length === 0) {
    return (
      <EmptyState
        icon="check-circle"
        title={workType === "REVIEW_REQUIRED" ? "Review queue is empty" : "No escalations match these filters"}
        description={
          workType === "REVIEW_REQUIRED"
            ? "No low-confidence classifications are waiting for review."
            : "All clear — no customer escalations found for the current selection."
        }
      />
    );
  }

  const th = "px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-foreground/45";

  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
      {/* lg+: compact 5-column table. The type column is dropped — the active tab already says which list this is. */}
      <table className="hidden w-full table-fixed text-sm lg:table">
        <colgroup>
          <col />
          <col className="w-40" />
          <col className="w-44" />
          <col className="w-32" />
          <col className="w-32" />
        </colgroup>
        <thead>
          <tr className="border-b border-border-subtle bg-surface-muted/40">
            <th className={`${th} pl-5`}>Customer</th>
            <th className={th}>Classification</th>
            <th className={th}>Status &amp; SLA</th>
            <th className={th}>Classified</th>
            <th className={`${th} pr-5 text-right`}>Actions</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {items.map((item) => (
            <tr key={item.id} className="align-top transition-colors hover:bg-surface-muted/30">
              <td className="py-3.5 pl-5 pr-4">
                <CustomerCell item={item} query={query} />
              </td>
              <td className="px-4 py-3.5">
                <ClassificationCell item={item} />
              </td>
              <td className="px-4 py-3.5">
                <StatusCell item={item} />
              </td>
              <td className="px-4 py-3.5 text-xs text-foreground/55">{formatDateTime(item.classifiedAt)}</td>
              <td className="py-3.5 pl-4 pr-5">
                <div className="flex justify-end">
                  <WorkItemActions item={item} compact />
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* Below lg: one card per item, so nothing scrolls sideways on a phone. */}
      <ul className="divide-y divide-border-subtle lg:hidden">
        {items.map((item) => (
          <li key={item.id} className="flex flex-col gap-3 px-4 py-4 sm:px-5">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <CustomerCell item={item} query={query} />
              </div>
              <span className="shrink-0 text-xs text-foreground/45">{formatDateTime(item.classifiedAt)}</span>
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <ClassificationCell item={item} />
              <StatusCell item={item} />
            </div>
            <WorkItemActions item={item} />
          </li>
        ))}
      </ul>

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

const isTerminal = (item: WorkItem) =>
  item.workflowStatus === "RESOLVED" || item.workflowStatus === "CLOSED" || item.workflowStatus === "NOT_A_PROBLEM";

/**
 * Customer per spec 6.3 (falls back to the sender when no unique customer matched), linked to the detail page,
 * plus the mailbox as a one-click filter.
 */
function CustomerCell({ item, query }: { item: WorkItem; query: Query }) {
  const name = item.customerDisplayName ?? item.senderFrom ?? "Unknown sender";
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <Link
        href={`/escalations/${item.id}`}
        className="truncate text-sm font-medium text-foreground hover:text-teal-dark hover:underline"
        title={name}
      >
        {name}
      </Link>
      {item.customerDisplayName ? (
        item.senderFrom && (
          <span className="truncate text-xs text-foreground/45" title={item.senderFrom}>
            {item.senderFrom}
          </span>
        )
      ) : (
        <span className="text-xs text-foreground/40">No customer match</span>
      )}
      <Link
        href={listHref(BASE_PATH, { ...query, mailbox_address: item.mailboxAddress })}
        className="truncate text-xs text-foreground/45 hover:text-teal-dark hover:underline"
        title={`Show only ${item.mailboxAddress}`}
      >
        <Icon name="mail" className="mr-1 inline h-3 w-3 align-[-2px]" />
        {item.mailboxAddress}
      </Link>
    </div>
  );
}

function ClassificationCell({ item }: { item: WorkItem }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <ClassificationLabel label={item.classificationLabel} />
      <span className="text-xs text-foreground/40">{formatFraction(item.confidence)} confidence</span>
    </div>
  );
}

function StatusCell({ item }: { item: WorkItem }) {
  return (
    <div className="flex flex-col items-start gap-1">
      <div className="flex flex-wrap gap-1">
        <WorkflowBadge status={item.workflowStatus} />
        {item.slaState !== "UNCONFIGURED" && <SlaBadge state={item.slaState} />}
      </div>
      {item.resolutionDeadline && !isTerminal(item) && (
        <span className="text-xs text-foreground/40">Due {formatDateTime(item.resolutionDeadline)}</span>
      )}
    </div>
  );
}

export function WorkItemFilterChips({
  query,
  workType,
  workflowStatus,
  slaState,
  mailboxAddress,
}: {
  query: Query;
  workType: WorkItemWorkType;
  workflowStatus?: WorkItemWorkflowStatus;
  slaState?: WorkItemSlaState;
  mailboxAddress?: string;
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

  // Escalations and the review queue are separate lists (spec 6.3), so the type is a tab, never "all".
  const tab = (value: WorkItemWorkType, label: string) => {
    const isActive = workType === value;
    // Changing the list drops the other filters, since a status/SLA chosen for one list rarely applies to the other.
    const href = listHref(BASE_PATH, value === "ESCALATION" ? {} : { work_type: value });
    return (
      <Link
        key={value}
        href={href}
        aria-current={isActive ? "page" : undefined}
        className={`-mb-px border-b-2 px-1 pb-2.5 text-sm font-medium transition ${
          isActive ? "border-ink text-foreground" : "border-transparent text-foreground/50 hover:text-foreground"
        }`}
      >
        {label}
      </Link>
    );
  };

  return (
    <div className="mb-5">
      <nav className="mb-4 flex gap-6 border-b border-border-subtle" aria-label="Work item list">
        {tab("ESCALATION", "Escalations")}
        {tab("REVIEW_REQUIRED", "Review queue")}
      </nav>
      <div className="flex flex-wrap gap-3">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by status">
          {chip("workflow_status", "OPEN", "Open", workflowStatus)}
          {chip("workflow_status", "ACKNOWLEDGED", "Acknowledged", workflowStatus)}
          {chip("workflow_status", "RESOLVED", "Resolved", workflowStatus)}
          {chip("workflow_status", "NOT_A_PROBLEM", "Not a problem", workflowStatus)}
        </div>
        <div className="h-4 w-px self-center bg-border-subtle" aria-hidden="true" />
        <div className="flex flex-wrap gap-2" role="group" aria-label="Filter by SLA">
          {chip("sla_state", "BREACHED", "SLA Breached", slaState)}
          {chip("sla_state", "ON_TRACK", "SLA On Track", slaState)}
          {chip("sla_state", "MET", "SLA Met", slaState)}
        </div>
      </div>
      <MailboxFilter query={query} mailboxAddress={mailboxAddress} />
    </div>
  );
}

/**
 * Plain GET form so it works without client JS; the other active filters ride along as hidden inputs
 * and the page resets to 1. The backend matches the mailbox exactly (addresses are stored lowercased).
 */
function MailboxFilter({ query, mailboxAddress }: { query: Query; mailboxAddress?: string }) {
  const rest: Query = { ...query, mailbox_address: undefined };
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2">
      <form method="get" action={BASE_PATH} className="flex items-center gap-2" role="search">
        {Object.entries(rest).map(([key, value]) =>
          value ? <input key={key} type="hidden" name={key} value={value} /> : null,
        )}
        <label htmlFor="mailbox-filter" className="sr-only">
          Filter by mailbox
        </label>
        <input
          key={mailboxAddress ?? ""}
          id="mailbox-filter"
          name="mailbox_address"
          type="email"
          defaultValue={mailboxAddress}
          placeholder="Filter by mailbox, e.g. service@trufinity.ca"
          className="w-72 max-w-full rounded-full border border-border-subtle bg-surface px-3.5 py-1.5 text-xs text-foreground placeholder:text-foreground/35 focus:border-teal-dark/50 focus:outline-none"
        />
        <button
          type="submit"
          className="rounded-full bg-surface-muted px-3.5 py-1.5 text-xs font-medium text-foreground/70 transition hover:bg-surface-muted/70"
        >
          Apply
        </button>
      </form>
      {mailboxAddress && (
        <Link
          href={listHref(BASE_PATH, rest)}
          className="inline-flex items-center gap-1 rounded-full bg-ink px-3 py-1.5 text-xs font-medium text-white"
          aria-label={`Clear mailbox filter ${mailboxAddress}`}
        >
          {mailboxAddress}
          <Icon name="x" className="h-3 w-3" />
        </Link>
      )}
    </div>
  );
}
