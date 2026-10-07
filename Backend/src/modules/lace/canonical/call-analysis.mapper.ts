import type { LaceCallAnalysisRow } from '../lace.types';

export interface CanonicalLaceCall {
  laceCallId: string;
  crm: string | null;
  csr: string | null;
  company: string | null;
  campaign: string | null;
  callLink: string;
  jobNumber: string | null;
  crmCallId: string | null;
  crmTenantId: string | null;
  customerName: string | null;
  customerPhone: string | null;
  callDirection: string | null;
  booked: boolean | null;
  qualified: boolean | null;
  existingCustomer: boolean | null;
  durationSec: number | null;
  playbookScore: number | null;
  objections: string[] | null;
  unbookedReason: string | null;
  cancellationReason: string | null;
  shortSummary: string | null;
  qualificationDetails: string | null;
  receivedAt: Date | null;
  sourceSpecificData: Record<string, unknown>;
}

function nullableString(value: string | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

function parseYesNoBoolean(value: string | undefined): boolean | null {
  const normalized = value?.trim().toLowerCase();
  if (normalized === 'yes') return true;
  if (normalized === 'no') return false;
  return null;
}

// "Booked" / "Unbooked"; "Qualified" / "Not qualified" - confirmed against the
// real live export, not the original (wrong) sample CSV. See call-analysis.ingestion.ts.
function parseBooked(value: string | undefined): boolean | null {
  if (value === 'Booked') return true;
  if (value === 'Unbooked') return false;
  return null;
}

function parseQualified(value: string | undefined): boolean | null {
  if (value === 'Qualified') return true;
  if (value === 'Not qualified') return false;
  return null;
}

function parseInteger(value: string | undefined): number | null {
  if (typeof value !== 'string') return null;
  const digits = value.replace(/[^0-9-]/g, '');
  if (digits.length === 0) return null;
  const parsed = Number.parseInt(digits, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

// e.g. "Service Fee Concerns, Other, Customer Data Privacy Concerns" -> 3 categories.
function parseObjections(value: string | undefined): string[] | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  const categories = value.split(',').map((category) => category.trim()).filter((category) => category.length > 0);
  return categories.length > 0 ? categories : null;
}

// "Date received (UTC)" ("2026-02-18") + "Time received (UTC)" ("16:09:28") -> a UTC instant.
function parseReceivedAt(dateUtc: string | undefined, timeUtc: string | undefined): Date | null {
  if (!dateUtc || !timeUtc) return null;
  const parsed = new Date(`${dateUtc}T${timeUtc}Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function mapCallAnalysisRowToCanonical(laceCallId: string, row: LaceCallAnalysisRow): CanonicalLaceCall {
  return {
    laceCallId,
    crm: nullableString(row.CRM),
    csr: nullableString(row.CSR),
    company: nullableString(row.Company),
    campaign: nullableString(row.Campaign),
    callLink: row['Call link'],
    jobNumber: nullableString(row['Job number']),
    crmCallId: nullableString(row['CRM call id']),
    crmTenantId: nullableString(row['CRM tenant id']),
    customerName: nullableString(row['Customer name']),
    customerPhone: nullableString(row['Customer phone']),
    callDirection: nullableString(row['Call direction']),
    booked: parseBooked(row.Booked),
    qualified: parseQualified(row.Qualified),
    existingCustomer: parseYesNoBoolean(row['Existing customer']),
    durationSec: parseInteger(row['Duration (sec)']),
    playbookScore: parseInteger(row['Playbook score']),
    objections: parseObjections(row.Objections),
    unbookedReason: nullableString(row['Unbooked reason']),
    cancellationReason: nullableString(row['Cancellation reason']),
    shortSummary: nullableString(row['Short summary']),
    qualificationDetails: nullableString(row['Qualification details']),
    receivedAt: parseReceivedAt(row['Date received (UTC)'], row['Time received (UTC)']),
    sourceSpecificData: row as unknown as Record<string, unknown>,
  };
}
