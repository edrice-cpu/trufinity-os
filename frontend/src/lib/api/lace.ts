import "server-only";
import { cache } from "react";
import { apiGet } from "./client";

// ─── Types ────────────────────────────────────────────────────────────────────

export type LaceExportType = "call_analysis" | "agent_performance";
export type LaceFeedStatus = "OK" | "STALE" | "FAILING" | "NO_DATA";

export interface LaceExportFreshness {
  exportType: LaceExportType;
  status: LaceFeedStatus;
  lastRunStatus: string | null;
  lastRunStartedAt: string | null;       // ISO 8601
  lastRunCompletedAt: string | null;     // ISO 8601
  lastRunRecordsProcessed: number | null;
  lastSuccessfulSyncAt: string | null;   // ISO 8601
  consecutiveFailures: number;
  lastFileIngestedAt: string | null;     // ISO 8601
  latestDataAt: string | null;           // ISO 8601 — newest business date in data
  latestRawRecordCount: number;
  maxFileAgeHours: number;
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Returns the health / freshness of each Lace AI data feed.
 * Memoized per request via React `cache()`.
 *
 * Per SPEC-BI-001 §7: a FAILING or STALE feed must NEVER be silently hidden.
 */
export const getLaceSyncStatus = cache(() =>
  apiGet<LaceExportFreshness[]>("/api/reporting/lace/sync-status"),
);

// ─── Display helpers ──────────────────────────────────────────────────────────

/** Maps snake_case exportType values to human-readable labels. */
export function laceExportLabel(exportType: LaceExportType): string {
  return exportType === "call_analysis" ? "Call Analysis" : "Agent Performance";
}

