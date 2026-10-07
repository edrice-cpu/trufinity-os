"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { navItems } from "@/lib/nav";
import { Icon } from "@/components/ui/Icon";
import { Logo } from "@/components/ui/Logo";

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-ink text-white">
      <div className="flex h-16 items-center border-b border-white/10 px-5">
        <Logo variant="light" />
      </div>

      <nav className="flex-1 space-y-1 overflow-y-auto px-3 py-4">
        {navItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavigate}
              className={`group flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition ${
                isActive
                  ? "bg-white/10 text-white"
                  : "text-white/60 hover:bg-white/5 hover:text-white"
              }`}
            >
              <Icon
                name={item.icon as Parameters<typeof Icon>[0]["name"]}
                className={`h-4.5 w-4.5 shrink-0 ${isActive ? "text-teal" : "text-white/40 group-hover:text-white/70"}`}
              />
              <span className="truncate">{item.label}</span>
              {isActive && <span className="ml-auto h-1.5 w-1.5 shrink-0 rounded-full bg-brand" />}
            </Link>
          );
        })}
      </nav>

      <div className="border-t border-white/10 p-4">
        <div className="rounded-xl bg-white/5 p-3.5">
          <p className="text-xs font-medium text-white/80">Connected data sources</p>
          <p className="mt-1 text-[11px] leading-relaxed text-white/40">
            ServiceTitan, QuickBooks, Google Ads &amp; more will appear here once connected.
          </p>
        </div>
      </div>
    </div>
  );
}
