import { BUSINESS_TIMEZONE } from "./format";

/**
 * Dashboard filters, kept in the URL so server components can read them from `searchParams`.
 * Each filtered card owns a param prefix (e.g. `inv` → `invFrom` / `invTo`) so cards on the
 * same page filter independently.
 */

export type SearchParams = Record<string, string | string[] | undefined>;

/** ISO dates (YYYY-MM-DD). Both omitted = month-to-date, the backend default. */
export interface DateRange {
  from?: string;
  to?: string;
}

/** Fixed list — the backend doesn't return it anywhere. Values must match exactly. Omitted = all departments. */
export const DEPARTMENTS = ["Company", "Service", "New Construction"] as const;
export type Department = (typeof DEPARTMENTS)[number];

export const dateParamKeys = (prefix: string) => ({ from: `${prefix}From`, to: `${prefix}To` });
export const departmentParamKey = (prefix: string) => `${prefix}Dept`;

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export function firstParam(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 1-based page number from `?page=`; anything missing or invalid is page 1. */
export function readPage(sp: SearchParams): number {
  const page = Math.floor(Number(firstParam(sp.page)));
  return Number.isFinite(page) && page > 1 ? page : 1;
}

/**
 * Explicit "everything" range for lookups that must not follow the MTD default
 * (e.g. the list of job statuses used as filter chips).
 */
export const ALL_TIME_RANGE: DateRange = { from: "2000-01-01" };

export function isIsoDate(value: string | undefined): value is string {
  return !!value && ISO_DATE.test(value) && !Number.isNaN(Date.parse(value));
}

export function readDateRange(sp: SearchParams, prefix: string): DateRange {
  const keys = dateParamKeys(prefix);
  const from = firstParam(sp[keys.from]);
  const to = firstParam(sp[keys.to]);
  const range: DateRange = {
    from: isIsoDate(from) ? from : undefined,
    to: isIsoDate(to) ? to : undefined,
  };
  // An inverted range can only come from a hand-edited URL; fall back to the MTD default.
  if (range.from && range.to && range.from > range.to) return {};
  return range;
}

/** Undefined = no department filter (all jobs). */
export function readDepartment(sp: SearchParams, prefix: string): Department | undefined {
  const value = firstParam(sp[departmentParamKey(prefix)]);
  return DEPARTMENTS.find((d) => d === value);
}

/** Stable string for Suspense keys, so changing a filter shows the loading state. */
export const rangeKey = (range: DateRange) => `${range.from ?? ""}_${range.to ?? ""}`;

// ---- Date presets (pure date-string math in the business timezone; no figures derived) ----

/** Today's date as YYYY-MM-DD in the business timezone. */
export function todayIso(now: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: BUSINESS_TIMEZONE }).format(now);
}

const pad = (n: number) => String(n).padStart(2, "0");
const iso = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
const lastDayOfMonth = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

function shiftDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export const DATE_PRESETS = [
  { id: "mtd", label: "This month (MTD)" },
  { id: "last-month", label: "Last month" },
  { id: "last-30", label: "Last 30 days" },
  { id: "ytd", label: "Year to date" },
  { id: "custom", label: "Custom range…" },
] as const;
export type DatePresetId = (typeof DATE_PRESETS)[number]["id"];

/** `mtd` maps to an empty range: omitting both params is the backend's MTD default. */
export function presetRange(id: Exclude<DatePresetId, "custom">, today: string = todayIso()): DateRange {
  const [y, m] = today.split("-").map(Number);
  switch (id) {
    case "mtd":
      return {};
    case "last-month": {
      const py = m === 1 ? y - 1 : y;
      const pm = m === 1 ? 12 : m - 1;
      return { from: iso(py, pm, 1), to: iso(py, pm, lastDayOfMonth(py, pm)) };
    }
    case "last-30":
      return { from: shiftDays(today, -29), to: today };
    case "ytd":
      return { from: iso(y, 1, 1), to: today };
  }
}

export function matchPreset(range: DateRange, today: string = todayIso()): DatePresetId {
  if (!range.from && !range.to) return "mtd";
  for (const id of ["last-month", "last-30", "ytd"] as const) {
    const p = presetRange(id, today);
    if (p.from === range.from && p.to === range.to) return id;
  }
  return "custom";
}
