import { EmptyState, ErrorState, SkeletonTable } from "@/components/ui/States";
import { AlertRow } from "@/components/alerts/AlertRow";
import { listAlerts, type DetectedAlert } from "@/lib/api/alerts";
import { getRuleMeta } from "@/lib/rules";
import type { DateRange } from "@/lib/filters";

/** F-series alerts (F-03 discount leakage, F-04 AR aging, F-04c AR concentration, F-04d credit memos, F-05 revenue reconciliation), default month-to-date. */
export async function FinancialAlerts({ ruleCode, limit, range = {} }: { ruleCode?: string; limit?: number; range?: DateRange }) {
  let alerts: DetectedAlert[];
  try {
    alerts = await listAlerts(ruleCode, range);
  } catch {
    return <ErrorState title="Couldn't load financial alerts" />;
  }

  const financial = alerts.filter((a) => getRuleMeta(a.rule_code).section === "financial");
  const shown = limit ? financial.slice(0, limit) : financial;

  if (shown.length === 0) {
    return (
      <EmptyState
        icon="check-circle"
        title="No financial alerts"
        description={`${ruleCode ? `No ${ruleCode} exceptions` : "No AR, discount, credit memo or revenue reconciliation exceptions"} detected in this period.`}
      />
    );
  }

  return (
    <div className="-mx-5 divide-y divide-border-subtle sm:-mx-6">
      {shown.map((alert) => (
        <AlertRow key={alert.id} alert={alert} />
      ))}
    </div>
  );
}

export function FinancialAlertsSkeleton() {
  return <SkeletonTable rows={3} />;
}
