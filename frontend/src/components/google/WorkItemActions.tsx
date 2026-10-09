"use client";

import { useState, useTransition, useRef } from "react";
import { useRouter } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import { Spinner } from "@/components/ui/States";
import { acknowledgeWorkItemAction, dismissWorkItemAction, resolveWorkItemAction } from "@/app/(dashboard)/escalations/actions";
import type { WorkItem } from "@/lib/api/google";

const MAX_NOTE = 2000;

/** `compact` = icon-only buttons (label kept as tooltip + accessible name) for dense tables. */
export function WorkItemActions({ item, compact = false }: { item: WorkItem; compact?: boolean }) {
  const canAcknowledge = item.workflowStatus === "OPEN";
  const canClose = item.workflowStatus === "OPEN" || item.workflowStatus === "ACKNOWLEDGED";

  if (!canAcknowledge && !canClose) return null;

  return (
    <div className="flex items-center gap-1">
      {canAcknowledge && (
        <ActionButton
          action={() => acknowledgeWorkItemAction(item.id)}
          icon="check"
          label="Ack"
          title="Acknowledge (claim) this item"
          fallbackError="Failed to acknowledge."
          className="text-info hover:bg-info-soft"
          compact={compact}
        />
      )}
      {canClose && <ResolveButton id={item.id} compact={compact} />}
      {canClose && (
        <ActionButton
          action={() => dismissWorkItemAction(item.id)}
          icon="x"
          label="Not a problem"
          title="Not a problem — logged and used to tune the classifier"
          fallbackError="Failed to mark as not a problem."
          className="text-foreground/60 hover:bg-surface-muted"
          compact={compact}
        />
      )}
    </div>
  );
}

/** One-tap server action button that refreshes the page on success and shows the error inline otherwise. */
function ActionButton({
  action,
  icon,
  label,
  title,
  fallbackError,
  className,
  compact,
}: {
  action: () => Promise<{ ok: boolean; message?: string }>;
  icon: "check" | "x";
  label: string;
  title: string;
  fallbackError: string;
  className: string;
  compact: boolean;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const handleClick = () => {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (result.ok) {
        router.refresh();
      } else {
        setError(result.message ?? fallbackError);
      }
    });
  };

  return (
    <div className="relative">
      <button
        onClick={handleClick}
        disabled={pending}
        title={title}
        aria-label={compact ? label : undefined}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border-subtle text-xs font-medium transition disabled:opacity-50 ${
          compact ? "h-7 w-7 justify-center" : "px-2.5 py-1"
        } ${className}`}
      >
        {pending ? <Spinner className="h-3 w-3" /> : <Icon name={icon} className="h-3.5 w-3.5" />}
        {!compact && label}
      </button>
      {error && (
        <span className="absolute right-0 top-full mt-1 z-10 whitespace-nowrap rounded bg-danger px-2 py-1 text-xs text-white">
          {error}
        </span>
      )}
    </div>
  );
}

function ResolveButton({ id, compact }: { id: string; compact: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        title="Resolve this item (requires a note)"
        aria-label={compact ? "Resolve" : undefined}
        className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg border border-border-subtle text-xs font-medium text-success hover:bg-success-soft transition ${
          compact ? "h-7 w-7 justify-center" : "px-2.5 py-1"
        }`}
      >
        <Icon name="check-circle" className="h-3.5 w-3.5" />
        {!compact && "Resolve"}
      </button>
      {open && <ResolveModal id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

function ResolveModal({ id, onClose }: { id: string; onClose: () => void }) {
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();
  const overlayRef = useRef<HTMLDivElement>(null);

  const trimmed = note.trim();
  const valid = trimmed.length >= 1 && trimmed.length <= MAX_NOTE;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!valid || pending) return;
    setError(null);
    startTransition(async () => {
      const result = await resolveWorkItemAction(id, trimmed);
      if (result.ok) {
        router.refresh();
        onClose();
      } else {
        setError(result.message ?? "Failed to resolve.");
      }
    });
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === overlayRef.current) onClose();
  };

  return (
    <div
      ref={overlayRef}
      onClick={handleOverlayClick}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="resolve-modal-title"
    >
      <div className="w-full max-w-md rounded-2xl border border-border-subtle bg-surface p-6 shadow-xl">
        <div className="mb-4 flex items-center justify-between">
          <h2 id="resolve-modal-title" className="text-base font-semibold text-foreground">
            Resolve Work Item
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="rounded-lg p-1.5 text-foreground/40 hover:bg-surface-muted hover:text-foreground transition"
          >
            <Icon name="x" className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="flex flex-col gap-4">
          <div>
            <label htmlFor="resolution-note" className="mb-1.5 block text-xs font-medium uppercase tracking-wide text-foreground/55">
              Resolution note <span className="text-danger">*</span>
            </label>
            <textarea
              id="resolution-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={5}
              maxLength={MAX_NOTE}
              placeholder="Describe how this item was resolved…"
              disabled={pending}
              className="w-full rounded-xl border border-border-subtle bg-surface-muted/40 px-3 py-2.5 text-sm text-foreground placeholder:text-foreground/30 focus:border-teal-dark/50 focus:outline-none disabled:opacity-60 resize-none"
            />
            <div className="mt-1 flex justify-end text-xs text-foreground/40">
              {note.trim().length}/{MAX_NOTE}
            </div>
          </div>

          {error && (
            <p className="rounded-lg bg-danger-soft px-3 py-2 text-xs text-danger">{error}</p>
          )}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={pending}
              className="rounded-lg border border-border-subtle px-3.5 py-2 text-xs font-medium text-foreground/70 hover:bg-surface-muted transition disabled:opacity-50"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={!valid || pending}
              className="inline-flex items-center gap-1.5 rounded-lg bg-ink px-3.5 py-2 text-xs font-semibold text-white transition hover:opacity-90 disabled:opacity-40"
            >
              {pending && <Spinner className="h-3 w-3" />}
              {pending ? "Resolving…" : "Resolve"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
