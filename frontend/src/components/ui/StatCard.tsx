import type { KpiMetric } from "@/lib/types";
import { Icon } from "./Icon";
import { Card } from "./Card";

const trendStyles = {
  up: "text-success",
  down: "text-danger",
  flat: "text-foreground/50",
};

const trendIcon = {
  up: "arrow-up",
  down: "arrow-down",
  flat: "minus",
} as const;

export function StatCard({ metric }: { metric: KpiMetric }) {
  return (
    <Card className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-foreground/50">{metric.label}</span>
      <span className="text-2xl font-semibold tracking-tight text-foreground">{metric.value}</span>
      <div className="flex items-center gap-1.5 text-xs">
        {metric.delta && metric.trend && (
          <span className={`inline-flex items-center gap-1 font-medium ${trendStyles[metric.trend]}`}>
            <Icon name={trendIcon[metric.trend]} className="h-3.5 w-3.5" />
            {metric.delta}
          </span>
        )}
        {metric.helpText && <span className="text-foreground/45">{metric.helpText}</span>}
      </div>
    </Card>
  );
}
