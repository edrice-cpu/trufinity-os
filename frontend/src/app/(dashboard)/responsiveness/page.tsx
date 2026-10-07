import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusPill } from "@/components/ui/Badge";
import { Icon } from "@/components/ui/Icon";
import { PendingState } from "@/components/ui/States";
import { sectionReady } from "@/lib/sections";
import type { ResponsivenessRow } from "@/lib/types";

// TODO: replace with responsiveness API data once available.
const responsiveness: ResponsivenessRow[] = [];

const channelIcon: Record<string, string> = {
  "Phone (Dialpad)": "clock",
  "AI Call Agent (Lace AI)": "megaphone",
  "Email (service@)": "mail",
  "Google Business Profile": "star",
};

export default function ResponsivenessPage() {
  return (
    <div>
      <PageHeader
        title="Responsiveness"
        description="How quickly the business responds to customers across phone, AI call agent, email, and reviews."
      />

      {!sectionReady.responsiveness ? (
        <PendingState />
      ) : (
      <Card padded={false}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[700px] text-left text-sm">
            <thead>
              <tr className="border-b border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
                <th className="px-5 py-3 font-medium sm:px-6">Channel</th>
                <th className="px-5 py-3 font-medium sm:px-6">Metric</th>
                <th className="px-5 py-3 font-medium sm:px-6">Today</th>
                <th className="px-5 py-3 font-medium sm:px-6">7-day Avg.</th>
                <th className="px-5 py-3 font-medium sm:px-6">Target</th>
                <th className="px-5 py-3 font-medium sm:px-6">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {responsiveness.map((row) => (
                <tr key={row.id}>
                  <td className="px-5 py-3.5 sm:px-6">
                    <div className="flex items-center gap-2.5">
                      <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-teal-light text-teal-dark">
                        <Icon name={(channelIcon[row.channel] ?? "clock") as Parameters<typeof Icon>[0]["name"]} className="h-4 w-4" />
                      </span>
                      <div>
                        <span className="font-medium text-foreground">{row.channel}</span>
                        {row.syncNote && <p className="text-[11px] text-foreground/40">{row.syncNote}</p>}
                      </div>
                    </div>
                  </td>
                  <td className="px-5 py-3.5 text-foreground/75 sm:px-6">{row.metric}</td>
                  <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">{row.today}</td>
                  <td className="px-5 py-3.5 text-foreground/50 sm:px-6">{row.weekAvg}</td>
                  <td className="px-5 py-3.5 text-foreground/50 sm:px-6">{row.target}</td>
                  <td className="px-5 py-3.5 sm:px-6">
                    <StatusPill status={row.status} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      )}
    </div>
  );
}
