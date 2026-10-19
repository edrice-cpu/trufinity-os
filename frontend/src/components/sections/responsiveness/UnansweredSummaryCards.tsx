import { formatCount } from "@/lib/format";
import type { UnansweredEmailSummary } from "@/lib/api/responsiveness";

const PAGE_SIZE = 20;

interface StatCardProps {
  label: string;
  value: number;
  tone?: "danger" | "warning" | "neutral";
}

function StatCard({ label, value, tone = "neutral" }: StatCardProps) {
  const valueClass =
    tone === "danger"
      ? "text-danger"
      : tone === "warning"
        ? "text-warning"
        : "text-foreground";
  return (
    <div className="flex flex-col gap-1 rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm">
      <p className="text-xs font-medium uppercase tracking-wide text-foreground/45">{label}</p>
      <p className={`text-3xl font-semibold tabular-nums ${valueClass}`}>{formatCount(value)}</p>
    </div>
  );
}

export function UnansweredSummaryCards({ summary }: { summary: UnansweredEmailSummary }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatCard label="Total Alerts" value={summary.totalCount} tone={summary.totalCount > 0 ? "warning" : "neutral"} />
      <StatCard label="Emergency" value={summary.emergency} tone={summary.emergency > 0 ? "danger" : "neutral"} />
      <StatCard label="General" value={summary.general} />
      <StatCard label="Open" value={summary.byStatus.OPEN} tone={summary.byStatus.OPEN > 0 ? "warning" : "neutral"} />
    </div>
  );
}

export { PAGE_SIZE };

