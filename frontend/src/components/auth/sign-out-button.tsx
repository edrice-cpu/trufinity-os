"use client";

import { useFormStatus } from "react-dom";
import { Icon } from "@/components/ui/Icon";

export function SignOutButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      title="Sign out"
      className="flex h-9 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-foreground/60 transition hover:bg-surface-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-dark disabled:cursor-not-allowed disabled:opacity-60"
    >
      <Icon name="log-out" className="h-4 w-4" />
      <span className="hidden sm:inline">{pending ? "Signing out…" : "Sign out"}</span>
      <span className="sr-only sm:hidden">Sign out</span>
    </button>
  );
}
