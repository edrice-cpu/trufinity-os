"use client";

import { useState } from "react";
import {
  DATE_PRESETS,
  dateParamKeys,
  isIsoDate,
  matchPreset,
  presetRange,
  todayIso,
  type DatePresetId,
  type DateRange,
} from "@/lib/filters";
import { useUrlParams } from "./useUrlParams";
import { Spinner } from "@/components/ui/States";

export const filterControlClass =
  "rounded-lg border border-border-subtle bg-surface px-2.5 py-1.5 text-xs font-medium text-foreground transition focus:border-teal-dark/50 focus:outline-none disabled:opacity-60";

/**
 * Shared date filter for summary cards. Writes `${prefix}From` / `${prefix}To` to the URL;
 * the "This month" preset clears both, which the backend treats as month-to-date.
 */
export function DateRangePicker({ prefix, range }: { prefix: string; range: DateRange }) {
  const keys = dateParamKeys(prefix);
  const { setParams, isPending } = useUrlParams();
  const today = todayIso();
  const [customOpen, setCustomOpen] = useState(false);
  const preset: DatePresetId = customOpen ? "custom" : matchPreset(range, today);

  // Custom inputs edit a local draft; the URL (and the fetch) only changes on Apply.
  const appliedFrom = range.from ?? `${today.slice(0, 8)}01`;
  const appliedTo = range.to ?? today;
  const [draft, setDraft] = useState({ from: appliedFrom, to: appliedTo });
  const draftValid = isIsoDate(draft.from) && isIsoDate(draft.to) && draft.from <= draft.to && draft.to <= today;
  const draftChanged = draft.from !== range.from || draft.to !== range.to;

  const apply = (next: DateRange) => setParams({ [keys.from]: next.from, [keys.to]: next.to });

  const onPreset = (id: DatePresetId) => {
    if (id === "custom") {
      setDraft({ from: appliedFrom, to: appliedTo });
      setCustomOpen(true);
      return;
    }
    setCustomOpen(false);
    apply(presetRange(id, today));
  };

  return (
    <div className="flex flex-wrap items-center gap-2" aria-busy={isPending}>
      <select
        aria-label="Date range"
        className={filterControlClass}
        value={preset}
        onChange={(e) => onPreset(e.target.value as DatePresetId)}
      >
        {DATE_PRESETS.map((p) => (
          <option key={p.id} value={p.id}>
            {p.label}
          </option>
        ))}
      </select>
      {preset === "custom" && (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (draftValid && draftChanged) apply(draft);
          }}
        >
          <input
            type="date"
            aria-label="From date"
            className={filterControlClass}
            value={draft.from}
            max={draft.to || today}
            onChange={(e) => setDraft((d) => ({ ...d, from: e.target.value }))}
          />
          <span className="text-xs text-foreground/45">to</span>
          <input
            type="date"
            aria-label="To date"
            className={filterControlClass}
            value={draft.to}
            min={draft.from}
            max={today}
            onChange={(e) => setDraft((d) => ({ ...d, to: e.target.value }))}
          />
          <button
            type="submit"
            disabled={!draftValid || !draftChanged || isPending}
            className="rounded-lg bg-ink px-3 py-1.5 text-xs font-medium text-white transition hover:opacity-90 disabled:opacity-40"
          >
            Apply
          </button>
        </form>
      )}
      {isPending && <Spinner className="h-4 w-4 text-teal-dark" />}
    </div>
  );
}
