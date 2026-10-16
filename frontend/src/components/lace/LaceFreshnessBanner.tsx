import { getLaceSyncStatus, laceExportLabel, type LaceExportFreshness, type LaceFeedStatus } from "@/lib/api/lace";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/components/ui/Icon";

// ─── Banner config per status ─────────────────────────────────────────────────

interface BannerStyle {
  wrapperClass: string;
  iconName: "alert-triangle" | "x-circle" | "info";
  iconClass: string;
}

const BANNER_STYLES: Record<Exclude<LaceFeedStatus, "OK">, BannerStyle> = {
  STALE: {
    wrapperClass: "border-warning/30 bg-warning-soft/80 text-warning-dark",
    iconName: "alert-triangle",
    iconClass: "text-warning",
  },
  FAILING: {
    wrapperClass: "border-danger/30 bg-danger-soft/80 text-danger-dark",
    iconName: "x-circle",
    iconClass: "text-danger",
  },
  NO_DATA: {
    wrapperClass: "border-orange-300/40 bg-orange-50/80 text-orange-900 dark:border-orange-600/30 dark:bg-orange-950/40 dark:text-orange-200",
    iconName: "info",
    iconClass: "text-orange-500 dark:text-orange-400",
  },
};

// ─── Per-feed banner message ──────────────────────────────────────────────────

function bannerMessage(feed: LaceExportFreshness): string {
  const label = laceExportLabel(feed.exportType);
  switch (feed.status) {
    case "STALE":
      return `Lace ${label} data is stale — no new file for over ${feed.maxFileAgeHours} hours`;
    case "FAILING":
      return `Lace ${label} sync is failing — ${feed.consecutiveFailures} consecutive failure${feed.consecutiveFailures === 1 ? "" : "s"}`;
    case "NO_DATA":
      return `No Lace ${label} data has ever been ingested`;
    default:
      return "";
  }
}

// ─── Single-feed inline banner ────────────────────────────────────────────────

function FeedBanner({ feed }: { feed: LaceExportFreshness }) {
  if (feed.status === "OK") return null;

  const style = BANNER_STYLES[feed.status];

  return (
    <div
      role="alert"
      aria-live="polite"
      className={`flex items-start gap-3 rounded-xl border px-4 py-3 text-sm ${style.wrapperClass}`}
    >
      <Icon name={style.iconName} className={`mt-0.5 h-4 w-4 shrink-0 ${style.iconClass}`} />
      <div className="min-w-0 flex-1">
        <p className="font-medium">{bannerMessage(feed)}</p>
        {feed.lastFileIngestedAt && (
          <p className="mt-0.5 text-xs opacity-70">
            Last file ingested: {formatDateTime(feed.lastFileIngestedAt)}
            {feed.latestDataAt && ` · Latest data: ${formatDateTime(feed.latestDataAt)}`}
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Main exported component ──────────────────────────────────────────────────

/**
 * LaceFreshnessBanner — Server Component.
 *
 * Renders an alert banner for each degraded Lace AI feed (STALE / FAILING / NO_DATA).
 * Renders nothing when both feeds are OK, or when the status endpoint is unreachable
 * (we degrade silently rather than block the whole shell).
 *
 * Per SPEC-BI-001 §7: a failing or stale feed must NEVER be silently hidden.
 */
export async function LaceFreshnessBanner() {
  let feeds: LaceExportFreshness[];
  try {
    feeds = await getLaceSyncStatus();
  } catch {
    // Do not crash the layout if the status endpoint is temporarily unreachable.
    // The next hard refresh will try again (no-store cache).
    return null;
  }

  const degraded = feeds.filter((f) => f.status !== "OK");
  if (degraded.length === 0) return null;

  return (
    <div className="flex flex-col gap-2 px-4 pt-3 sm:px-6">
      {degraded.map((feed) => (
        <FeedBanner key={feed.exportType} feed={feed} />
      ))}
    </div>
  );
}

