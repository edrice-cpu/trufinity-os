import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { PriorityBadge, StatusBadge } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { getFlaggedItemById } from "@/lib/mock-data";

export default async function FlaggedItemDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const item = getFlaggedItemById(id);

  if (!item) notFound();

  const backHref = item.type === "escalation" ? "/escalations" : "/red-flags";

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={backHref} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground/55 hover:text-foreground">
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to {item.type === "escalation" ? "Customer Escalations" : "Red Flags"}
      </Link>

      <Card className="mb-6">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <PriorityBadge priority={item.priority} />
              <StatusBadge status={item.status} />
            </div>
            <h1 className="text-xl font-semibold tracking-tight text-foreground">{item.title}</h1>
            <p className="mt-1 text-sm text-foreground/55">
              {item.customer} &middot; Reported {item.createdAt}
            </p>
          </div>
          <button className="inline-flex items-center gap-1.5 self-start rounded-lg bg-ink px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-90">
            <Icon name="check-circle" className="h-3.5 w-3.5" />
            Mark as resolved
          </button>
        </div>

        <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-border-subtle pt-5 sm:grid-cols-4">
          <div>
            <dt className="text-xs font-medium uppercase tracking-wide text-foreground/45">Source</dt>
            <dd className="mt-1 text-sm text-foreground">{item.source}</dd>
          </div>
          {item.jobNumber && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-foreground/45">Job #</dt>
              <dd className="mt-1 text-sm text-foreground">{item.jobNumber}</dd>
            </div>
          )}
          {item.invoiceNumber && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-foreground/45">Invoice #</dt>
              <dd className="mt-1 text-sm text-foreground">{item.invoiceNumber}</dd>
            </div>
          )}
          {item.amount && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-foreground/45">Amount</dt>
              <dd className="mt-1 text-sm text-foreground">{item.amount}</dd>
            </div>
          )}
          {item.assignedTo && (
            <div>
              <dt className="text-xs font-medium uppercase tracking-wide text-foreground/45">Assigned To</dt>
              <dd className="mt-1 text-sm text-foreground">{item.assignedTo}</dd>
            </div>
          )}
        </dl>
      </Card>

      <Card className="mb-6">
        <CardHeader title="Description" />
        <p className="text-sm leading-relaxed text-foreground/75">{item.description}</p>
      </Card>

      {item.relatedMessages && item.relatedMessages.length > 0 && (
        <Card className="mb-6">
          <CardHeader title="Related messages" subtitle="Supporting communication for this item" />
          <div className="space-y-3">
            {item.relatedMessages.map((msg, i) => (
              <div key={i} className="rounded-xl border border-border-subtle bg-surface-muted/50 p-4">
                <div className="mb-1.5 flex items-center justify-between text-xs text-foreground/50">
                  <span className="font-medium text-foreground/70">{msg.from} &middot; {msg.channel}</span>
                  <span>{msg.timestamp}</span>
                </div>
                <p className="text-sm text-foreground/75">&ldquo;{msg.snippet}&rdquo;</p>
              </div>
            ))}
          </div>
        </Card>
      )}

      <Card>
        <CardHeader title="Timeline" subtitle="Activity history for this item" />
        <ol className="space-y-5">
          {item.timeline.map((event, i) => (
            <li key={i} className="relative flex gap-3.5 pl-0.5">
              <div className="flex flex-col items-center">
                <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-teal-dark" />
                {i < item.timeline.length - 1 && <span className="mt-1 w-px flex-1 bg-border-subtle" />}
              </div>
              <div className="pb-1">
                <p className="text-sm text-foreground/85">
                  <span className="font-medium text-foreground">{event.actor}</span> &mdash; {event.action}
                </p>
                <p className="mt-0.5 text-xs text-foreground/45">{event.timestamp}</p>
              </div>
            </li>
          ))}
        </ol>
      </Card>
    </div>
  );
}
