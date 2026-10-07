"use client";

import { ErrorState } from "@/components/ui/States";

export default function DashboardError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div className="mx-auto max-w-lg py-10">
      <ErrorState onRetry={reset} />
    </div>
  );
}
