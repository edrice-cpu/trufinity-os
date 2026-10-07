import Link from "next/link";
import { Icon } from "./Icon";
import { EmptyState } from "./States";
import { LinkPending } from "./LinkPending";
import { formatCount } from "@/lib/format";

type Query = Record<string, string | undefined>;

/** Builds `basePath?query&page=N`, dropping empty params and `page=1`. */
export function listHref(basePath: string, query: Query, page = 1): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) if (v) params.set(k, v);
  if (page > 1) params.set("page", String(page));
  const qs = params.toString();
  return `${basePath}${qs ? `?${qs}` : ""}`;
}

export const lastPageOf = (totalCount: number, pageSize: number) => Math.max(1, Math.ceil(totalCount / pageSize));

/** Link-based pagination for server-rendered tables; keeps existing query params. */
export function Pagination({
  basePath,
  query,
  page,
  pageSize,
  totalCount,
}: {
  basePath: string;
  query: Query;
  page: number;
  pageSize: number;
  totalCount: number;
}) {
  const lastPage = lastPageOf(totalCount, pageSize);
  const firstRow = (page - 1) * pageSize + 1;
  const lastRow = Math.min(page * pageSize, totalCount);
  const btn = "inline-flex items-center gap-1 rounded-lg border border-border-subtle px-3 py-1.5 text-xs font-medium";

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border-subtle px-5 py-3 text-xs text-foreground/55 sm:px-6"
    >
      <span>
        Showing {formatCount(firstRow)}–{formatCount(lastRow)} of {formatCount(totalCount)} · Page {formatCount(page)} of{" "}
        {formatCount(lastPage)}
      </span>
      <div className="flex gap-2">
        {page > 1 ? (
          <Link href={listHref(basePath, query, page - 1)} rel="prev" className={`${btn} text-foreground hover:bg-surface-muted`}>
            <Icon name="chevron-left" className="h-3.5 w-3.5" /> Prev <LinkPending className="h-3 w-3" />
          </Link>
        ) : (
          <span aria-disabled="true" className={`${btn} text-foreground/30`}>
            <Icon name="chevron-left" className="h-3.5 w-3.5" /> Prev
          </span>
        )}
        {page < lastPage ? (
          <Link href={listHref(basePath, query, page + 1)} rel="next" className={`${btn} text-foreground hover:bg-surface-muted`}>
            <LinkPending className="h-3 w-3" /> Next <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </Link>
        ) : (
          <span aria-disabled="true" className={`${btn} text-foreground/30`}>
            Next <Icon name="chevron-right" className="h-3.5 w-3.5" />
          </span>
        )}
      </div>
    </nav>
  );
}

/** Shown when `?page=` points past the last page (stale link, or the data shrank since). */
export function PageOutOfRange({ basePath, query, lastPage }: { basePath: string; query: Query; lastPage: number }) {
  return (
    <EmptyState
      title="This page doesn't exist"
      description={`There are only ${formatCount(lastPage)} page${lastPage === 1 ? "" : "s"} for this filter.`}
      action={
        <Link href={listHref(basePath, query, lastPage)} className="text-xs font-medium text-teal-dark hover:underline">
          Go to the last page
        </Link>
      }
    />
  );
}

export function FilterChips({
  basePath,
  param,
  options,
  active,
  query = {},
}: {
  basePath: string;
  param: string;
  options: { value: string; label: string }[];
  active?: string;
  /** Other params to keep on each chip link (e.g. an active date filter). Changing a chip resets the page. */
  query?: Query;
}) {
  const chip = (value: string | undefined, label: string) => {
    const isActive = (active ?? "") === (value ?? "");
    return (
      <Link
        key={value ?? "all"}
        href={listHref(basePath, { ...query, [param]: value })}
        aria-current={isActive ? "true" : undefined}
        className={`inline-flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-xs font-medium transition ${
          isActive ? "bg-ink text-white" : "bg-surface-muted text-foreground/60 hover:bg-surface-muted/70"
        }`}
      >
        {label}
        <LinkPending className="h-3 w-3" />
      </Link>
    );
  };
  return (
    <div className="mb-5 flex flex-wrap gap-2" role="group" aria-label="Filter">
      {chip(undefined, "All")}
      {options.map((o) => chip(o.value, o.label))}
    </div>
  );
}
