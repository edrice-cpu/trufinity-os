import { PageHeader } from "@/components/ui/PageHeader";
import { PendingState } from "@/components/ui/States";

// Spec Section 7: all RED exceptions other than customer escalations, ranked by estimated dollar impact.
// Goes live once the backend returns RED F/O-series alerts with a dollar-impact figure; render them with AlertRow.
export default function RedFlagsPage() {
  return (
    <div>
      <PageHeader
        title="Red Flags"
        description="RED exceptions other than customer escalations, ranked by estimated dollar impact — what happened, the number, the affected department or person, and a drill-down link."
      />
      <PendingState />
    </div>
  );
}
