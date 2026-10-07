import Link from "next/link";
import { Icon } from "@/components/ui/Icon";
import { ClampedText } from "@/components/ui/ClampedText";
import type { DetectedAlert } from "@/lib/api/alerts";
import { formatDateTime } from "@/lib/format";
import { formatDimension, formatMetric, getRuleMeta, severityStyles } from "@/lib/rules";

export function RuleBadge({ code }: { code: string }) {
  const meta = getRuleMeta(code);
  return (
    <span className={`inline-flex rounded-full px-2 py-0.5 text-[11px] font-semibold ${severityStyles[meta.severity]}`}>
      {code}
    </span>
  );
}

/** Narrative is pre-validated by the backend; when missing, fall back to the raw numbers. */
export function alertSummary(alert: DetectedAlert): string {
  if (alert.narrative) return alert.narrative;
  const meta = getRuleMeta(alert.rule_code);
  const current = `${meta.metricLabel}: ${formatMetric(alert.metric_value, meta.metricFormat)}`;
  // Point-in-time rules (e.g. F-04c) have no baseline.
  return alert.baseline_value == null ? current : `${current} vs. baseline ${formatMetric(alert.baseline_value, meta.metricFormat)}`;
}

export function AlertRow({ alert }: { alert: DetectedAlert }) {
  const meta = getRuleMeta(alert.rule_code);
  return (
    // Stretched link: the whole row navigates, while the "See more" toggle sits above it.
    <div className="relative flex items-start gap-4 px-5 py-4 transition hover:bg-surface-muted/50 sm:px-6">
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex flex-wrap items-center gap-2">
          <RuleBadge code={alert.rule_code} />
          <Link href={`/alerts/${alert.id}`} className="text-sm font-medium text-foreground after:absolute after:inset-0">
            {meta.label}
          </Link>
          <span className="text-xs text-foreground/45">· {formatDimension(alert.dimension)}</span>
        </div>
        <ClampedText text={alertSummary(alert)} className="text-sm text-foreground/70" />
        <div className="mt-1.5 flex flex-wrap gap-x-3 text-xs text-foreground/45">
          <span>
            {meta.metricLabel} {formatMetric(alert.metric_value, meta.metricFormat)}
            {alert.baseline_value != null && <> · baseline {formatMetric(alert.baseline_value, meta.metricFormat)}</>}
          </span>
          <span>Detected {formatDateTime(alert.detected_at)} PT</span>
          {!alert.narrative && <span className="italic">Narrative pending</span>}
        </div>
      </div>
      <Icon name="chevron-right" className="mt-1 h-4 w-4 shrink-0 text-foreground/30" />
    </div>
  );
}
