import type { CountByLabel } from "@/lib/api/servicetitan";
import { formatCount, formatEnumLabel } from "@/lib/format";

export function CountList({ items, emptyText = "No records" }: { items: CountByLabel[]; emptyText?: string }) {
  if (items.length === 0) return <p className="text-xs text-foreground/45">{emptyText}</p>;
  return (
    <ul className="divide-y divide-border-subtle text-sm">
      {items.map((item) => (
        <li key={item.label} className="flex items-center justify-between py-2 first:pt-0 last:pb-0">
          <span className="text-foreground/70">{formatEnumLabel(item.label)}</span>
          <span className="font-medium tabular-nums text-foreground">{formatCount(item.count)}</span>
        </li>
      ))}
    </ul>
  );
}
