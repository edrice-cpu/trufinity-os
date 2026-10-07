import { Card, CardHeader } from "@/components/ui/Card";
import { ErrorState, SkeletonTable } from "@/components/ui/States";
import {
  getCustomerIdentityQuality,
  getPaymentApplicationIntegrity,
  getQboCompleteness,
  type EntityCompleteness,
} from "@/lib/api/reporting";
import { formatCount } from "@/lib/format";
import { MetricTile, issueTone } from "./MetricTile";

const entities = ["Customer", "Invoice", "Payment"] as const;

const completenessColumns: { key: keyof EntityCompleteness; label: string; isIssue?: boolean }[] = [
  { key: "latestNonDeletedRawCount", label: "Raw Records" },
  { key: "activeIdentityCount", label: "Active Identities" },
  { key: "unifiedTargetCount", label: "Unified" },
  { key: "brokenTargetCount", label: "Broken Links", isIssue: true },
  { key: "duplicateSourceIdentityCount", label: "Duplicates", isIssue: true },
  { key: "mappingErrorCount", label: "Mapping Errors", isIssue: true },
];

export async function DataQualityPanel() {
  // Each block handles its own failure so one bad endpoint doesn't blank the whole panel.
  const [completeness, identity, integrity] = await Promise.allSettled([
    getQboCompleteness(),
    getCustomerIdentityQuality(),
    getPaymentApplicationIntegrity(),
  ]);

  return (
    <div className="space-y-6">
      <Card padded={false}>
        <div className="px-5 pt-5 sm:px-6 sm:pt-6">
          <CardHeader title="QuickBooks Sync Completeness" subtitle="Raw records vs. mapped / unified records per entity" />
        </div>
        {completeness.status === "rejected" ? (
          <div className="px-5 pb-5 sm:px-6 sm:pb-6">
            <ErrorState title="Couldn't load sync completeness" />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-left text-sm">
              <thead>
                <tr className="border-y border-border-subtle text-xs uppercase tracking-wide text-foreground/45">
                  <th className="px-5 py-3 font-medium sm:px-6">Entity</th>
                  {completenessColumns.map((col) => (
                    <th key={col.key} className="px-5 py-3 text-right font-medium sm:px-6">
                      {col.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-border-subtle">
                {entities.map((entity) => {
                  const row = completeness.value[entity];
                  return (
                    <tr key={entity}>
                      <td className="px-5 py-3.5 font-medium text-foreground sm:px-6">{entity}</td>
                      {completenessColumns.map((col) => {
                        const value = row?.[col.key];
                        const flagged = col.isIssue && (value ?? 0) > 0;
                        return (
                          <td
                            key={col.key}
                            className={`px-5 py-3.5 text-right tabular-nums sm:px-6 ${
                              flagged ? "font-semibold text-warning" : "text-foreground/75"
                            }`}
                          >
                            {formatCount(value)}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader title="Customer Identity Match" subtitle="ServiceTitan ↔ QuickBooks customer matching quality" />
          {identity.status === "rejected" ? (
            <ErrorState title="Couldn't load identity quality" />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MetricTile label="ServiceTitan Customers" value={formatCount(identity.value.serviceTitanCustomerIdentityCount)} />
              <MetricTile label="Verified (Tier A)" value={formatCount(identity.value.verifiedTierACount)} tone="success" />
              <MetricTile label="Merged" value={formatCount(identity.value.mergedCount)} />
              <MetricTile
                label="Unresolved"
                value={formatCount(identity.value.unresolvedCount)}
                tone={issueTone(identity.value.unresolvedCount)}
              />
              <MetricTile
                label="Broken Unified Links"
                value={formatCount(identity.value.brokenUnifiedTargetCount)}
                tone={issueTone(identity.value.brokenUnifiedTargetCount)}
              />
              <MetricTile
                label="Tier A w/o QBO Target"
                value={formatCount(identity.value.tierAWithoutSharedQboTarget)}
                tone={issueTone(identity.value.tierAWithoutSharedQboTarget)}
              />
              <MetricTile
                label="Unresolved Sharing QBO"
                value={formatCount(identity.value.unresolvedSharingQboTarget)}
                tone={issueTone(identity.value.unresolvedSharingQboTarget)}
              />
            </div>
          )}
        </Card>

        <Card>
          <CardHeader title="Payment Application Integrity" subtitle="Payment ↔ invoice link health" />
          {integrity.status === "rejected" ? (
            <ErrorState title="Couldn't load payment integrity" />
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <MetricTile label="Application Rows" value={formatCount(integrity.value.totalApplicationRows)} />
              <MetricTile
                label="Orphan Payment Refs"
                value={formatCount(integrity.value.orphanPaymentReferences)}
                tone={issueTone(integrity.value.orphanPaymentReferences)}
              />
              <MetricTile
                label="Orphan Invoice Refs"
                value={formatCount(integrity.value.orphanInvoiceReferences)}
                tone={issueTone(integrity.value.orphanInvoiceReferences)}
              />
              <MetricTile
                label="Duplicate Pairs"
                value={formatCount(integrity.value.duplicatePaymentInvoicePairs)}
                tone={issueTone(integrity.value.duplicatePaymentInvoicePairs)}
              />
              <MetricTile
                label="Stale QBO Identity"
                value={formatCount(integrity.value.applicationsWithInactiveOrDeletedQboIdentity)}
                tone={issueTone(integrity.value.applicationsWithInactiveOrDeletedQboIdentity)}
                helpText="Inactive or deleted"
              />
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}

export function DataQualitySkeleton() {
  return <SkeletonTable rows={4} />;
}
