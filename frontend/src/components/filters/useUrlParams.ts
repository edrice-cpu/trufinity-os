"use client";

import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

/**
 * Merges param updates into the current URL (undefined removes a param) and navigates in a
 * transition, so the server components re-fetch with the new filters. Reads `window.location`
 * at call time instead of `useSearchParams`, which keeps pages prerender-safe.
 */
export function useUrlParams() {
  const router = useRouter();
  const pathname = usePathname();
  const [isPending, startTransition] = useTransition();

  const setParams = (updates: Record<string, string | undefined>) => {
    const params = new URLSearchParams(window.location.search);
    for (const [key, value] of Object.entries(updates)) {
      if (value) params.set(key, value);
      else params.delete(key);
    }
    params.delete("page");
    const qs = params.toString();
    const next = `${pathname}${qs ? `?${qs}` : ""}`;
    // Re-selecting the current value shouldn't trigger a server round-trip.
    if (next === `${window.location.pathname}${window.location.search}`) return;
    startTransition(() => router.replace(next, { scroll: false }));
  };

  return { setParams, isPending };
}
