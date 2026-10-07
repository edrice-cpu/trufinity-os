import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, CardHeader } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { ErrorState } from "@/components/ui/States";
import { MetricTile } from "@/components/sections/MetricTile";
import { RuleBadge, alertSummary } from "@/components/alerts/AlertRow";
import { getAlert, type DetectedAlert } from "@/lib/api/alerts";
import { formatDate, formatDateTime, humanizeKey } from "@/lib/format";
import { formatDimension, formatMetric, getRuleMeta } from "@/lib/rules";

const sectionBack: Record<string, { href: string; label: string }> = {
  demand: { href: "/demand-alerts", label: "Demand Alerts" },
  financial: { href: "/financial-alerts", label: "Financial Alerts" },
  escalations: { href: "/escalations", label: "Customer Escalations" },
  redFlags: { href: "/red-flags", label: "Red Flags" },
};

function formatPeriod(start: string | null, end: string | null): string {
  if (!start && !end) return "—";
  return `${formatDate(start)} – ${formatDate(end)}`;
}

function formatDetailValue(value: unknown): string {
  if (value == null) return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(formatDetailValue).join(", ");
  return Object.entries(value as Record<string, unknown>)
    .map(([k, v]) => `${humanizeKey(k)}: ${formatDetailValue(v)}`)
    .join(" · ");
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:gap-4">
      <dt className="w-44 shrink-0 text-xs font-medium uppercase tracking-wide text-foreground/45">{label}</dt>
      <dd className="text-sm text-foreground/80">{children}</dd>
    </div>
  );
}

export default async function AlertDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let alert: DetectedAlert | null;
  try {
    alert = await getAlert(id);
  } catch {
    return <ErrorState title="Couldn't load this alert" />;
  }
  if (!alert) notFound();

  const meta = getRuleMeta(alert.rule_code);
  const back = sectionBack[meta.section] ?? { href: "/dashboard", label: "Dashboard" };
  const details = Object.entries(alert.details ?? {});

  return (
    <div className="mx-auto max-w-3xl">
      <Link href={back.href} className="mb-4 inline-flex items-center gap-1.5 text-sm font-medium text-foreground/55 hover:text-foreground">
        <Icon name="arrow-left" className="h-4 w-4" />
        Back to {back.label}
      </Link>

      <Card className="mb-6">
        <div className="mb-2 flex flex-wrap items-center gap-2">
          <RuleBadge code={alert.rule_code} />
          <span className="text-xs text-foreground/45">{formatDimension(alert.dimension)}</span>
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground">{meta.label}</h1>
        <p className="mt-3 text-[15px] leading-relaxed text-foreground/75">{alertSummary(alert)}</p>
        {!alert.narrative && <p className="mt-1 text-xs italic text-foreground/45">Narrative not generated yet — showing raw values.</p>}

        <div className="mt-5 grid grid-cols-2 gap-3">
          <MetricTile label={meta.metricLabel} value={formatMetric(alert.metric_value, meta.metricFormat)} />
          {alert.baseline_value != null && (
            <MetricTile label="Baseline" value={formatMetric(alert.baseline_value, meta.metricFormat)} />
          )}
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
        <Card>
          <CardHeader title="Alert record" />
          <dl className="divide-y divide-border-subtle">
            <Row label="Rule code">{alert.rule_code}</Row>
            <Row label="Dimension">{formatDimension(alert.dimension)}</Row>
            <Row label="Period">{formatPeriod(alert.period_start, alert.period_end)}</Row>
            <Row label="Baseline period">{formatPeriod(alert.baseline_start, alert.baseline_end)}</Row>
            <Row label="Detected at">{formatDateTime(alert.detected_at)} PT</Row>
            <Row label="Narrated at">{alert.narrated_at ? `${formatDateTime(alert.narrated_at)} PT` : "—"}</Row>
          </dl>
        </Card>

        <Card>
          <CardHeader title="Details" subtitle="Rule-specific data behind this alert" />
          {details.length === 0 ? (
            <p className="text-sm text-foreground/45">No additional details.</p>
          ) : (
            <dl className="divide-y divide-border-subtle">
              {details.map(([key, value]) => (
                <Row key={key} label={humanizeKey(key)}>
                  {meta.detailFormats?.[key] && (typeof value === "string" || typeof value === "number")
                    ? formatMetric(String(value), meta.detailFormats[key])
                    : formatDetailValue(value)}
                </Row>
              ))}
            </dl>
          )}
        </Card>
      </div>
    </div>
  );
}
