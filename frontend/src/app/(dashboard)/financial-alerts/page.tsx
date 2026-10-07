import { Suspense } from "react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card } from "@/components/ui/Card";
import { FilterChips } from "@/components/ui/Pagination";
import { DateRangePicker } from "@/components/filters/DateRangePicker";
import { ALERTS_FILTER_PREFIX } from "@/components/sections/DemandAlerts";
import { FinancialAlerts, FinancialAlertsSkeleton } from "@/components/sections/FinancialAlerts";
import { dateParamKeys, firstParam, rangeKey, readDateRange, type SearchParams } from "@/lib/filters";
import { rulesForSection } from "@/lib/rules";

const BASE_PATH = "/financial-alerts";

export default async function FinancialAlertsPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const sp = await searchParams;
  const financialRules = rulesForSection("financial");
  const ruleCode = financialRules.find((r) => r.code === firstParam(sp.ruleCode))?.code;
  const range = readDateRange(sp, ALERTS_FILTER_PREFIX);
  const dateKeys = dateParamKeys(ALERTS_FILTER_PREFIX);

  return (
    <div>
      <PageHeader
        title="Financial Alerts"
        description="AR aging, AR concentration, discount leakage, credit memo spikes and revenue reconciliation gaps detected from QuickBooks and ServiceTitan data, newest first."
        action={<DateRangePicker prefix={ALERTS_FILTER_PREFIX} range={range} />}
      />
      <FilterChips
        basePath={BASE_PATH}
        param="ruleCode"
        active={ruleCode}
        options={financialRules.map((r) => ({ value: r.code, label: `${r.code} · ${r.label}` }))}
        query={{ [dateKeys.from]: range.from, [dateKeys.to]: range.to }}
      />
      <Card>
        <Suspense key={`${ruleCode ?? "all"}_${rangeKey(range)}`} fallback={<FinancialAlertsSkeleton />}>
          <FinancialAlerts ruleCode={ruleCode} range={range} />
        </Suspense>
      </Card>
    </div>
  );
}
