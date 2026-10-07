import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardHeader } from "@/components/ui/Card";
import { DataQualityPanel, DataQualitySkeleton } from "@/components/sections/DataQualityPanel";
import { SyncStatusPanel } from "@/components/sections/servicetitan/SyncStatusPanel";

export default function DataQualityPage() {
  return (
    <div>
      <PageHeader
        title="Data Quality"
        description="Sync health and integrity of QuickBooks and ServiceTitan data in the warehouse — broken links, duplicates and unresolved customer matches."
      />
      <Suspense fallback={<DataQualitySkeleton />}>
        <DataQualityPanel />
      </Suspense>
      <Card className="mt-6">
        <CardHeader title="ServiceTitan Sync Status" subtitle="Last sync run and last successful sync per entity" />
        <Suspense fallback={<DataQualitySkeleton />}>
          <SyncStatusPanel />
        </Suspense>
      </Card>
    </div>
  );
}
