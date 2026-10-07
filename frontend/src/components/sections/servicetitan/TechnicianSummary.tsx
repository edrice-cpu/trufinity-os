import { Card, CardHeader } from "@/components/ui/Card";
import { EmptyState, ErrorState } from "@/components/ui/States";
import { Pill } from "@/components/ui/Badge";
import { getServiceTitanSummary, type StTechnicianSummaryRow } from "@/lib/api/servicetitan";
import { canViewConfidential } from "@/lib/auth";
import { formatCount, formatMoney } from "@/lib/format";

export async function TechnicianSummary() {
  // Role check happens before any data is read, so restricted viewers never receive it.
  if (!(await canViewConfidential())) {
    return (
      <Card>
        <CardHeader title="Technician Performance" subtitle="Jobs sold and sold value per technician" />
        <EmptyState
          icon="lock"
          title="Restricted"
          description="Technician sales data is confidential and only visible to the owner."
        />
      </Card>
    );
  }

  let rows: StTechnicianSummaryRow[];
  try {
    rows = (await getServiceTitanSummary()).technicians;
  } catch {
    return <ErrorState title="Couldn't load technician performance" />;
  }

  return (
    <Card padded={false}>
      <div className="flex items-start justify-between gap-3 px-5 pt-5 sm:px-6 sm:pt-6">
        <CardHeader title="Technician Performance" subtitle="Jobs sold and sold value per technician" />
        <Pill tone="brand">Confidential</Pill>
      </div>
      {rows.length === 0 ? (
        <div className="px-5 pb-5 sm:px-6 sm:pb-6">
          <EmptyState title="No technician data" />
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[520px] text-left text-sm">
            <thead>
              <tr className="border-y border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
                <th className="px-5 py-3 font-medium sm:px-6">Technician</th>
                <th className="px-5 py-3 font-medium sm:px-6">Status</th>
                <th className="px-5 py-3 text-right font-medium sm:px-6">Jobs Sold</th>
                <th className="px-5 py-3 text-right font-medium sm:px-6">Sold Value</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border-subtle">
              {rows.map((tech) => (
                <tr key={tech.technicianId}>
                  <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">{tech.name ?? `#${tech.technicianId}`}</td>
                  <td className="px-5 py-3.5 text-foreground/60 sm:px-6">
                    {tech.active == null ? "—" : tech.active ? "Active" : "Inactive"}
                  </td>
                  <td className="px-5 py-3.5 text-right tabular-nums text-foreground/75 sm:px-6">{formatCount(tech.jobsSold)}</td>
                  <td className="px-5 py-3.5 text-right font-medium tabular-nums text-foreground sm:px-6">
                    {formatMoney(tech.jobsSoldValue)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
