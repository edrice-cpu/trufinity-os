"use client";

import { usePathname } from "next/navigation";
import { navItems } from "@/lib/nav";
import { Icon } from "@/components/ui/Icon";
import { companyMeta } from "@/lib/company";
import { formatReportDate } from "@/lib/format";
import { logoutAction } from "@/app/(auth)/actions";
import { SignOutButton } from "@/components/auth/sign-out-button";
import type { SessionUser } from "@/lib/auth/session";

function initialsOf(user: SessionUser): string {
  const source = user.fullName?.trim() || user.email;
  const parts = source.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function Topbar({ onMenuClick, user }: { onMenuClick: () => void; user: SessionUser }) {
  const pathname = usePathname();
  const active = navItems.find((item) => pathname === item.href || pathname.startsWith(`${item.href}/`));

  return (
    <header className="sticky top-0 z-20 flex h-16 items-center gap-3 border-b border-border-subtle bg-surface/95 px-4 backdrop-blur sm:px-6">
      <button
        onClick={onMenuClick}
        className="flex h-9 w-9 items-center justify-center rounded-lg text-foreground/60 hover:bg-surface-muted lg:hidden"
        aria-label="Open menu"
      >
        <Icon name="menu" className="h-5 w-5" />
      </button>

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-foreground">{active?.label ?? "Dashboard"}</p>
        <p className="hidden truncate text-xs text-foreground/45 sm:block">{formatReportDate()} &middot; {companyMeta.timezone}</p>
      </div>

      <div className="hidden items-center gap-2 rounded-lg border border-border-subtle bg-surface-muted/60 px-3 py-2 text-sm text-foreground/40 md:flex md:w-64">
        <Icon name="search" className="h-4 w-4" />
        <span className="text-xs">Search customers, jobs, invoices…</span>
      </div>

      <button className="relative flex h-9 w-9 items-center justify-center rounded-lg text-foreground/60 hover:bg-surface-muted">
        <Icon name="bell" className="h-4.5 w-4.5" />
        <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-brand ring-2 ring-surface" />
      </button>

      <div className="flex items-center gap-2.5 border-l border-border-subtle pl-3">
        <span className="flex h-8 w-8 items-center justify-center rounded-full bg-teal-light text-xs font-semibold text-teal-dark">
          {initialsOf(user)}
        </span>
        <div className="hidden max-w-[12rem] leading-tight sm:block">
          <p className="truncate text-xs font-medium text-foreground">{user.fullName ?? user.email}</p>
          {user.fullName && <p className="truncate text-[11px] text-foreground/45">{user.email}</p>}
        </div>
        <form action={logoutAction}>
          <SignOutButton />
        </form>
      </div>
    </header>
  );
}
