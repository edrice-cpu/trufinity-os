import { ErrorState, EmptyState } from "@/components/ui/States";
import { getStSyncStatus, type StSyncStatusRow } from "@/lib/api/servicetitan";
import { formatCount, formatDateTime, formatEnumLabel } from "@/lib/format";

function statusTone(status: string | null): string {
  const s = (status ?? "").toLowerCase();
  if (/fail|error/.test(s)) return "bg-danger-soft text-danger";
  if (/success|complete/.test(s)) return "bg-success-soft text-success";
  if (/run|progress|start/.test(s)) return "bg-warning-soft text-warning";
  return "bg-surface-muted text-foreground/60";
}

/** Last sync status + time per ServiceTitan entity (brief header freshness). */
export async function SyncStatusPanel() {
  let rows: StSyncStatusRow[];
  try {
    rows = await getStSyncStatus();
  } catch {
    return <ErrorState title="Couldn't load sync status" />;
  }
  if (rows.length === 0) return <EmptyState icon="clock" title="No sync runs recorded yet" />;

  return (
    <div className="overflow-x-auto rounded-xl border border-border-subtle">
      <table className="w-full min-w-[640px] text-left text-sm">
        <thead>
          <tr className="border-b border-border-subtle bg-surface-muted/40 text-xs uppercase tracking-wide text-foreground/45">
            <th className="px-4 py-2.5 font-medium">Entity</th>
            <th className="px-4 py-2.5 font-medium">Last Run</th>
            <th className="px-4 py-2.5 font-medium">Last Successful Sync</th>
            <th className="px-4 py-2.5 text-right font-medium">Processed</th>
            <th className="px-4 py-2.5 text-right font-medium">Raw Records</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border-subtle">
          {rows.map((row) => (
            <tr key={row.entityType}>
              <td className="px-4 py-3 font-medium text-foreground">{formatEnumLabel(row.entityType)}</td>
              <td className="px-4 py-3">
                <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-medium ${statusTone(row.lastRunStatus)}`}>
                  {formatEnumLabel(row.lastRunStatus)}
                </span>
                <span className="ml-2 text-xs text-foreground/45">
                  {formatDateTime(row.lastRunCompletedAt ?? row.lastRunStartedAt)}
                </span>
              </td>
              <td className="px-4 py-3 text-foreground/70">{formatDateTime(row.lastSuccessfulSyncAt)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground/70">{formatCount(row.lastRunRecordsProcessed)}</td>
              <td className="px-4 py-3 text-right tabular-nums text-foreground/70">{formatCount(row.latestRawRecordCount)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
