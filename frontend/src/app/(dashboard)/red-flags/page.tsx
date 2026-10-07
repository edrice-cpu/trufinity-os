import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { FlaggedTable } from "@/components/flagged/FlaggedTable";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { FlaggedItem } from "@/lib/types";

// TODO: replace with alerts API data once available.
const flaggedItems: FlaggedItem[] = [];

export default function RedFlagsPage() {
  const redFlags = flaggedItems.filter((item) => item.type === "red_flag");
  const open = redFlags.filter((item) => item.status === "open").length;
  const critical = redFlags.filter((item) => item.priority === "critical").length;

  return (
    <div>
      <PageHeader
        title="Red Flags"
        description="Operational and reputation risks surfaced automatically from jobs, invoices, and reviews."
      />

      {!sectionReady.redFlags ? (
        <PendingState />
      ) : (
      <>
      <div className="mb-6 grid grid-cols-2 gap-4 sm:grid-cols-3">
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Total Red Flags</p>
          <p className="mt-2 text-2xl font-semibold text-foreground">{redFlags.length}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Open</p>
          <p className="mt-2 text-2xl font-semibold text-danger">{open}</p>
        </Card>
        <Card>
          <p className="text-xs font-medium uppercase tracking-wide text-foreground/50">Critical</p>
          <p className="mt-2 text-2xl font-semibold text-danger">{critical}</p>
        </Card>
      </div>

      <FlaggedTable items={redFlags} />
      </>
      )}
    </div>
  );
}
