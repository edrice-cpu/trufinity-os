const toneStyles = {
  default: "text-foreground",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
} as const;

export type MetricTone = keyof typeof toneStyles;

export function MetricTile({
  label,
  value,
  helpText,
  tone = "default",
}: {
  label: string;
  value: string;
  helpText?: string;
  tone?: MetricTone;
}) {
  return (
    <div className="rounded-xl border border-border-subtle bg-surface-muted/40 px-4 py-3">
      <p className="text-[11px] font-medium uppercase tracking-wide text-foreground/50">{label}</p>
      <p className={`mt-1 text-lg font-semibold tracking-tight ${toneStyles[tone]}`}>{value}</p>
      {helpText && <p className="mt-0.5 text-[11px] text-foreground/45">{helpText}</p>}
    </div>
  );
}

/** Integrity counters: anything above zero is a problem worth highlighting. */
export function issueTone(count: number): MetricTone {
  return count > 0 ? "warning" : "success";
}
