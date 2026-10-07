import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/Badge";
import { Sparkline } from "@/components/ui/Sparkline";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { ScorecardMetric } from "@/lib/types";

// TODO: replace with scorecard API data once available.
const scorecard: ScorecardMetric[] = [];

const categories = Array.from(new Set(scorecard.map((s) => s.category)));

export default function ScorecardPage() {
  return (
    <div>
      <PageHeader title="Scorecard" description="Daily performance against target across every part of the business." />

      {!sectionReady.scorecard ? (
        <PendingState />
      ) : (
      <div className="space-y-6">
        {categories.map((category) => (
          <Card key={category} padded={false}>
            <div className="border-b border-border-subtle px-5 py-4 sm:px-6">
              <h3 className="text-sm font-semibold text-foreground">{category}</h3>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-sm">
                <thead>
                  <tr className="text-xs uppercase tracking-wide text-foreground/45">
                    <th className="px-5 py-3 font-medium sm:px-6">Metric</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Today</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Target</th>
                    <th className="px-5 py-3 font-medium sm:px-6">7-day trend</th>
                    <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border-subtle">
                  {scorecard
                    .filter((row) => row.category === category)
                    .map((row) => (
                      <tr key={row.id}>
                        <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">{row.metric}</td>
                        <td className="px-5 py-3.5 text-foreground/80 sm:px-6">{row.today}</td>
                        <td className="px-5 py-3.5 text-foreground/50 sm:px-6">{row.target}</td>
                        <td className="px-5 py-3.5 sm:px-6">
                          <Sparkline data={row.trend} />
                        </td>
                        <td className="px-5 py-3.5 sm:px-6">
                          <StatusPill status={row.status} />
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
      )}
    </div>
  );
}
