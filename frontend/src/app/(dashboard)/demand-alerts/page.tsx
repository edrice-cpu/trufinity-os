import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { FilterChips } from "@/components/ui/Pagination";
import { DateRangePicker } from "@/components/filters/DateRangePicker";
import { ALERTS_FILTER_PREFIX, DemandAlerts, DemandAlertsSkeleton } from "@/components/sections/DemandAlerts";
import { dateParamKeys, firstParam, rangeKey, readDateRange, type SearchParams } from "@/lib/filters";
import { rulesForSection } from "@/lib/rules";

const BASE_PATH = "/demand-alerts";

export default async function DemandAlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const demandRules = rulesForSection("demand");
  const ruleCode = demandRules.find((r) => r.code === firstParam(sp.ruleCode))?.code;
  const range = readDateRange(sp, ALERTS_FILTER_PREFIX);
  const dateKeys = dateParamKeys(ALERTS_FILTER_PREFIX);

  return (
    <div>
      <PageHeader
        title="Demand Alerts"
        description="Booking-rate declines and objection spikes detected from Lace AI call data, newest first."
        action={<DateRangePicker prefix={ALERTS_FILTER_PREFIX} range={range} />}
      />
      <FilterChips
        basePath={BASE_PATH}
        param="ruleCode"
        active={ruleCode}
        options={demandRules.map((r) => ({ value: r.code, label: `${r.code} · ${r.label}` }))}
        query={{ [dateKeys.from]: range.from, [dateKeys.to]: range.to }}
      />
      <Card>
        <Suspense key={`${ruleCode ?? "all"}_${rangeKey(range)}`} fallback={<DemandAlertsSkeleton />}>
          <DemandAlerts ruleCode={ruleCode} range={range} />
        </Suspense>
      </Card>
    </div>
  );
}
