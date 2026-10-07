import type { Request } from 'express';

export interface DateRangeFilter {
  from: Date;
  to: Date;
}

function parseDate(value: unknown): Date | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

// Month-to-date (MTD): the 1st of the current month (UTC) through now.
// Exported standalone so repository method defaults can use the same
// "no filter given" behavior without needing a fake Express Request.
export function defaultDateRangeFilter(): DateRangeFilter {
  const now = new Date();
  return { from: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)), to: now };
}

// `?from=` / `?to=` (ISO date/datetime strings) override either end of the
// MTD default independently.
export function parseDateRangeFilter(req: Request): DateRangeFilter {
  const defaults = defaultDateRangeFilter();
  return {
    from: parseDate(req.query.from) ?? defaults.from,
    to: parseDate(req.query.to) ?? defaults.to,
  };
}

// The three ServiceTitan Business Unit names this dashboard filters by -
// each is a distinct, non-overlapping slice.
export const SERVICETITAN_DEPARTMENTS = ['Company', 'Service', 'New Construction'] as const;
export type ServiceTitanDepartment = (typeof SERVICETITAN_DEPARTMENTS)[number];

// Omitted or invalid ?department= means no department filter, i.e. all jobs.
export function parseDepartmentFilter(req: Request): ServiceTitanDepartment | undefined {
  const raw = req.query.department;
  if (typeof raw === 'string' && (SERVICETITAN_DEPARTMENTS as readonly string[]).includes(raw)) {
    return raw as ServiceTitanDepartment;
  }
  return undefined;
}
