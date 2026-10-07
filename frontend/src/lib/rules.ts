import { formatDecimal, formatMoney, formatRatio } from "./format";

// Single lookup for rule codes (spec Section 5). New codes (F-*, E-*, O-*, R-*, M-*, P-*) get added here only.

export type RuleSeverity = "red" | "amber" | "blue";
export type RuleSection = "demand" | "financial" | "escalations" | "redFlags" | "watchList" | "opportunities" | "responsiveness" | "marketing";
/** How metric_value / baseline_value should be displayed. */
export type MetricFormat = "ratio" | "count" | "money" | "number";

export interface RuleMeta {
  code: string;
  label: string;
  section: RuleSection;
  severity: RuleSeverity;
  metricLabel: string;
  metricFormat: MetricFormat;
  /** Display format for specific `details` keys (anything not listed renders as-is). */
  detailFormats?: Record<string, MetricFormat>;
}

export const rules: Record<string, RuleMeta> = {
  "D-01": {
    code: "D-01",
    label: "Booking rate decline",
    section: "demand",
    severity: "red",
    metricLabel: "Booking rate",
    metricFormat: "ratio",
  },
  "D-06": {
    code: "D-06",
    label: "Objection category spike",
    section: "demand",
    severity: "amber",
    metricLabel: "Objection rate",
    metricFormat: "ratio",
  },
  "F-03": {
    code: "F-03",
    label: "Discount leakage",
    section: "financial",
    severity: "amber",
    metricLabel: "Discount-to-gross",
    metricFormat: "ratio",
    detailFormats: {
      currentGrossAmount: "money",
      currentDiscountAmount: "money",
      baselineGrossAmount: "money",
      baselineDiscountAmount: "money",
    },
  },
  "F-04": {
    code: "F-04",
    label: "AR aging spike",
    section: "financial",
    severity: "amber",
    metricLabel: "Overdue invoice share",
    metricFormat: "ratio",
    detailFormats: { currentOverdueBalance: "money", baselineOverdueBalance: "money" },
  },
  "F-04c": {
    code: "F-04c",
    label: "AR concentration",
    section: "financial",
    severity: "amber",
    metricLabel: "Top customer share of AR",
    metricFormat: "ratio",
    detailFormats: { topCustomerBalance: "money", totalOutstandingBalance: "money" },
  },
  "F-04d": {
    code: "F-04d",
    label: "Credit memo spike",
    section: "financial",
    severity: "red",
    metricLabel: "Credit memos this week",
    metricFormat: "money",
    detailFormats: { currentTotalAmount: "money", baselineTotalAmount: "money", baselineWeeklyAverage: "money" },
  },
  "F-05": {
    code: "F-05",
    label: "Revenue reconciliation gap",
    section: "financial",
    severity: "red",
    metricLabel: "ST vs. QBO revenue gap",
    metricFormat: "ratio",
    detailFormats: { quickbooksRevenue: "money", serviceTitanRevenue: "money", gapAmount: "money" },
  },
};

export function getRuleMeta(code: string): RuleMeta {
  return (
    rules[code] ?? {
      code,
      label: code,
      section: "watchList",
      severity: "amber",
      metricLabel: "Metric",
      metricFormat: "number",
    }
  );
}

export function rulesForSection(section: RuleSection): RuleMeta[] {
  return Object.values(rules).filter((r) => r.section === section);
}

export const severityStyles: Record<RuleSeverity, string> = {
  red: "bg-danger-soft text-danger",
  amber: "bg-warning-soft text-warning",
  blue: "bg-teal-light text-teal-dark",
};

/** Dimension values that are not a person/entity name. */
const dimensionLabels: Record<string, string> = {
  // Used by both D-01 (all CSRs) and F-05 (whole company), so keep it generic.
  TENANT_TOTAL: "Company total",
  QUICKBOOKS_TOTAL: "QuickBooks (company total)",
  SERVICETITAN_TOTAL: "ServiceTitan (company total)",
};

export function formatDimension(dimension: string): string {
  return dimensionLabels[dimension] ?? dimension;
}

export function formatMetric(value: string | null, format: MetricFormat): string {
  switch (format) {
    case "ratio":
      return formatRatio(value);
    case "money":
      return formatMoney(value);
    default:
      return formatDecimal(value);
  }
}
