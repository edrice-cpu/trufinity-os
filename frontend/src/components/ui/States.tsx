import type { ComponentProps, ReactNode } from "react";
import { Icon } from "./Icon";

export function EmptyState({
  icon = "eye",
  title,
  description,
  action,
}: {
  icon?: ComponentProps<typeof Icon>["name"];
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-border-subtle bg-surface-muted/60 px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-foreground/40">
        <Icon name={icon} className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        {description && <p className="mt-1 max-w-sm text-xs text-foreground/55">{description}</p>}
      </div>
      {action}
    </div>
  );
}

export function ErrorState({
  title = "Couldn't load this data",
  description = "Something went wrong while fetching this section. Try again in a moment.",
  onRetry,
}: {
  title?: string;
  description?: string;
  onRetry?: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-2xl border border-danger/20 bg-danger-soft/60 px-6 py-14 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-danger">
        <Icon name="alert-circle" className="h-5 w-5" />
      </span>
      <div>
        <p className="text-sm font-medium text-foreground">{title}</p>
        <p className="mt-1 max-w-sm text-xs text-foreground/55">{description}</p>
      </div>
      {onRetry && (
        <button
          onClick={onRetry}
          className="mt-1 rounded-lg bg-danger px-3.5 py-1.5 text-xs font-medium text-white transition hover:opacity-90"
        >
          Retry
        </button>
      )}
    </div>
  );
}

export function Skeleton({ className = "" }: { className?: string }) {
  return <div className={`animate-pulse rounded-md bg-surface-muted ${className}`} />;
}

export function SkeletonCard() {
  return (
    <div className="rounded-2xl border border-border-subtle bg-surface p-5 sm:p-6">
      <Skeleton className="h-3 w-24" />
      <Skeleton className="mt-3 h-7 w-20" />
      <Skeleton className="mt-3 h-3 w-32" />
    </div>
  );
}

export function SkeletonTable({ rows = 5 }: { rows?: number }) {
  return (
    <div className="overflow-hidden rounded-2xl border border-border-subtle bg-surface">
      <div className="space-y-3 p-5">
        {Array.from({ length: rows }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    </div>
  );
}

export function PendingState({ description }: { description?: string }) {
  return (
    <EmptyState
      icon="clock"
      title="No data yet — pending backend integration"
      description={description ?? "This section will populate automatically once its backend API is connected."}
    />
  );
}

export function Spinner({ className = "h-3.5 w-3.5" }: { className?: string }) {
  return (
    <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}

/** Route-level loading UI (loading.tsx): page header plus a cards or table body. */
export function PageSkeleton({ variant = "cards" }: { variant?: "cards" | "table" | "detail" }) {
  return (
    <div role="status" aria-label="Loading">
      <div className="mb-6">
        <Skeleton className="h-6 w-56" />
        <Skeleton className="mt-3 h-4 w-80 max-w-full" />
      </div>
      {variant === "cards" && (
        <>
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 xl:grid-cols-5">
            {Array.from({ length: 5 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
          <div className="mt-6">
            <SkeletonTable rows={4} />
          </div>
        </>
      )}
      {variant === "table" && (
        <>
          <Skeleton className="mb-5 h-8 w-80 max-w-full rounded-full" />
          <SkeletonTable rows={8} />
        </>
      )}
      {variant === "detail" && <SkeletonTable rows={6} />}
    </div>
  );
}
