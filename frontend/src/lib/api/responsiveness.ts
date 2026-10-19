import "server-only";
import { backendFetch } from "@/lib/auth/backend";

// ─── Types ────────────────────────────────────────────────────────────────────

export type UnansweredEmailStatus = "OPEN" | "REPLIED";
export type UnansweredEmailClassification = "EMERGENCY" | "GENERAL";

export interface UnansweredEmail {
  id: string;
  mailboxAddress: string;
  threadId: string;
  oldestUnansweredAt: string;
  businessMinutesElapsed: number;
  isEmergency: boolean;
  status: UnansweredEmailStatus;
  gmailThreadUrl: string | null;
}

export interface UnansweredEmailListResult {
  data: UnansweredEmail[];
  totalCount: number;
  page: number;
  pageSize: number;
}

export interface UnansweredEmailSummary {
  totalCount: number;
  byStatus: Record<UnansweredEmailStatus, number>;
  emergency: number;
  general: number;
}

interface BackendUnansweredEmailSummary {
  totalCount: number;
  byStatus: Partial<Record<UnansweredEmailStatus, number>>;
  byClassification: { emergency?: number; general?: number };
}

export interface UnansweredEmailFilters {
  page?: number;
  page_size?: number;
  status?: UnansweredEmailStatus;
  classification?: UnansweredEmailClassification;
  mailbox_address?: string;
}

// ─── Result union types ───────────────────────────────────────────────────────

export type UnansweredListFetchResult =
  | { kind: "ok"; data: UnansweredEmailListResult }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

export type UnansweredSummaryFetchResult =
  | { kind: "ok"; data: UnansweredEmailSummary }
  | { kind: "unauthenticated" }
  | { kind: "error"; message: string };

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildQuery(filters: UnansweredEmailFilters): string {
  const params = new URLSearchParams();
  if (filters.page && filters.page > 1) params.set("page", String(filters.page));
  if (filters.page_size) params.set("page_size", String(filters.page_size));
  if (filters.status) params.set("status", filters.status);
  if (filters.classification) params.set("classification", filters.classification);
  if (filters.mailbox_address) params.set("mailbox_address", filters.mailbox_address);
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

function logFailure(
  call: string,
  response: { status: number; data: unknown },
  message: string,
): { kind: "error"; message: string } {
  const backendMsg = (response.data as { message?: string } | null)?.message;
  console.error(
    `[responsiveness:${call}] backend responded ${response.status}${backendMsg ? `: ${backendMsg}` : ""}`,
  );
  return { kind: "error", message };
}

// ─── API functions ────────────────────────────────────────────────────────────

const BASE = "/api/google/reporting/responsiveness";

/**
 * R01 — Unanswered Emails List
 * GET /api/google/reporting/responsiveness/unanswered
 * Supports: page, page_size, status, classification, mailbox_address
 */
export async function listUnansweredEmails(
  token: string,
  filters: UnansweredEmailFilters = {},
): Promise<UnansweredListFetchResult> {
  try {
    const response = await backendFetch<{ data: UnansweredEmailListResult }>(
      `${BASE}/unanswered${buildQuery(filters)}`,
      { token },
    );
    if (response.status === 401) return { kind: "unauthenticated" };
    if (!response.ok || !response.data?.data) {
      const backendMsg = (response.data as { message?: string } | null)?.message;
      console.error(`[responsiveness:list] backend responded ${response.status}${backendMsg ? `: ${backendMsg}` : ""}`);
      return { kind: "error", message: "Failed to load unanswered emails." };
    }

    return { kind: "ok", data: response.data.data };
  } catch (err) {
    console.error("[responsiveness] backend unreachable:", err instanceof Error ? err.message : err);
    return { kind: "error", message: "Unable to reach the backend." };
  }
}

/**
 * R01 — Unanswered Emails Summary
 * GET /api/google/reporting/responsiveness/unanswered/summary
 * Supports: mailbox_address
 */
export async function getUnansweredSummary(
  token: string,
  mailboxAddress?: string,
): Promise<UnansweredSummaryFetchResult> {
  const qs = mailboxAddress
    ? `?mailbox_address=${encodeURIComponent(mailboxAddress)}`
    : "";
  try {
    const response = await backendFetch<{ data: BackendUnansweredEmailSummary }>(
      `${BASE}/unanswered/summary${qs}`,
      { token },
    );
    if (response.status === 401) return { kind: "unauthenticated" };
    if (!response.ok || !response.data?.data)
      return logFailure("summary", response, "Failed to load unanswered summary.");
    const data = response.data.data;
    return {
      kind: "ok",
      data: {
        totalCount: data.totalCount,
        byStatus: { OPEN: data.byStatus.OPEN ?? 0, REPLIED: data.byStatus.REPLIED ?? 0 },
        emergency: data.byClassification.emergency ?? 0,
        general: data.byClassification.general ?? 0,
      },
    };
  } catch (err) {
    console.error("[responsiveness] backend unreachable:", err instanceof Error ? err.message : err);
    return { kind: "error", message: "Unable to reach the backend." };
  }
}

