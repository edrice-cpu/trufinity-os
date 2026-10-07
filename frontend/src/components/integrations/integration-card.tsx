type StatusTone = "connected" | "disconnected" | "warning";

const toneClasses: Record<StatusTone, string> = {
  connected: "bg-success-soft text-success ring-success/20",
  disconnected: "bg-surface-muted text-foreground/60 ring-border-subtle",
  warning: "bg-warning-soft text-warning ring-warning/20",
};

const dotClasses: Record<StatusTone, string> = {
  connected: "bg-success",
  disconnected: "bg-foreground/30",
  warning: "bg-warning",
};

export function StatusBadge({ tone, label }: { tone: StatusTone; label: string }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${toneClasses[tone]}`}>
      <span aria-hidden="true" className={`size-1.5 rounded-full ${dotClasses[tone]}`} />
      {label}
    </span>
  );
}

export function IntegrationCard({
  name,
  logo,
  description,
  badge,
  children,
}: {
  name: string;
  logo: React.ReactNode;
  description: string;
  badge: React.ReactNode;
  children: React.ReactNode;
}) {
  const headingId = `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-heading`;
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-5 rounded-2xl border border-border-subtle bg-surface p-5 shadow-sm sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          {logo}
          <div>
            <h2 id={headingId} className="text-sm font-semibold text-foreground">
              {name}
            </h2>
            <p className="mt-0.5 text-xs text-foreground/55">{description}</p>
          </div>
        </div>
        <div className="shrink-0">{badge}</div>
      </div>
      {children}
    </section>
  );
}

export function DetailList({ items }: { items: { label: string; value: React.ReactNode }[] }) {
  return (
    <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map((item) => (
        <div key={item.label} className="flex flex-col">
          <dt className="text-foreground/50">{item.label}</dt>
          <dd className="font-medium break-all text-foreground">{item.value}</dd>
        </div>
      ))}
    </dl>
  );
}

export function ProviderMark({ initials, className }: { initials: string; className: string }) {
  return (
    <span aria-hidden="true" className={`flex size-10 items-center justify-center rounded-lg text-sm font-bold text-white ${className}`}>
      {initials}
    </span>
  );
}
