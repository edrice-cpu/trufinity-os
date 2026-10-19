"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";

export function NavProgressBar() {
  const pathname = usePathname();
  const [visible, setVisible] = useState(false);
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const prevPathRef = useRef(pathname);

  useEffect(() => {
    if (pathname === prevPathRef.current) return;
    prevPathRef.current = pathname;

    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];

    const t1 = setTimeout(() => setVisible(true), 80);
    const t2 = setTimeout(() => setVisible(false), 500);
    timersRef.current = [t1, t2];

    return () => timersRef.current.forEach(clearTimeout);
  }, [pathname]);

  if (!visible) return null;

  return (
    <div
      role="status"
      aria-label="Loading…"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/10"
    >
      <svg
        className="h-10 w-10 animate-spin text-brand"
        viewBox="0 0 24 24"
        fill="none"
        aria-hidden="true"
      >
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeOpacity="0.2" strokeWidth="3" />
        <path d="M22 12a10 10 0 0 0-10-10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      </svg>
    </div>
  );
}


