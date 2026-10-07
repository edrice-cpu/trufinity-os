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
      previousWeekGrossAmount: "money",
      previousWeekDiscountAmount: "money",
    },
  },
  // F-04/F-04c report dollars for both of their triggers (bracket crossing or
  // AR growth; single balance or top-five share) - see details.trigger.
  "F-04": {
    code: "F-04",
    label: "AR aging deterioration",
    section: "financial",
    severity: "amber",
    metricLabel: "Balance",
    metricFormat: "money",
    detailFormats: { totalBalance: "money", arAtPeriodStart: "money", arAtPeriodEnd: "money", growthAmount: "money" },
  },
  "F-04c": {
    code: "F-04c",
    label: "Large-balance concentration",
    section: "financial",
    severity: "amber",
    metricLabel: "Balance",
    metricFormat: "money",
    detailFormats: { customerBalance: "money", topBalance: "money", totalOutstandingBalance: "money", thresholdAmount: "money" },
  },
  "F-04d": {
    code: "F-04d",
    label: "Credit memo or write-down",
    section: "financial",
    severity: "red",
    metricLabel: "Amount",
    metricFormat: "money",
    detailFormats: { amount: "money", previousTotal: "money", newTotal: "money", thresholdAmount: "money" },
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
  // O-series per SPEC-BI-001 Section 5.2 - O-02 is RED (brief Red Flags), the rest AMBER (Watch List).
  "O-02": {
    code: "O-02",
    label: "Callback / warranty rate spike",
    section: "redFlags",
    severity: "red",
    metricLabel: "Callback rate",
    metricFormat: "ratio",
  },
  "O-05": {
    code: "O-05",
    label: "Technician performance outlier",
    section: "watchList",
    severity: "amber",
    metricLabel: "Avg ticket",
    metricFormat: "money",
    detailFormats: { completedJobsValue: "money", peerCompletedJobsValue: "money" },
  },
  "O-06": {
    code: "O-06",
    label: "Job completed, not invoiced",
    section: "watchList",
    severity: "amber",
    metricLabel: "Job total",
    metricFormat: "money",
    detailFormats: { jobTotal: "money" },
  },
  "O-07": {
    code: "O-07",
    label: "Same-address repeat visit",
    section: "watchList",
    severity: "amber",
    metricLabel: "Days since prior visit",
    metricFormat: "number",
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
