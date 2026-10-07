import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { FlaggedTable } from "@/components/flagged/FlaggedTable";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { FlaggedItem } from "@/lib/types";

// TODO: replace with alerts API data once available.
const flaggedItems: FlaggedItem[] = [];

export default function EscalationsPage() {
  const escalations = flaggedItems.filter((item) => item.type === "escalation");
  const open = escalations.filter((item) => item.status === "open").length;
  const highPriority = escalations.filter((item) => item.priority === "high" || item.priority === "critical").length;

  return (
    <div>
      <PageHeader
        title="Customer Escalations"
        description="Direct complaints and disputes raised by customers across phone, chat, and ServiceTitan."
      />

      {!sectionReady.escalations ? (
        <PendingState />
      ) : (
      <>
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Total Escalations</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{escalations.length}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Open</p>
          <p className="mt-2 text-2xl font-semibold text-danger">{open}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">High / Critical Priority</p>
          <p className="mt-2 text-2xl font-semibold text-warning">{highPriority}</p>
        </Card>
      </div>

      <FlaggedTable items={escalations} />
      </>
      )}
    </div>
  );
}
