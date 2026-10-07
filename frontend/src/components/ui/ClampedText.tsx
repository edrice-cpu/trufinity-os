"use client";

import { useEffect, useRef, useState } from "react";

/**
 * Clamps text to a few lines with a "See more" / "See less" toggle. The toggle only appears when
 * the text actually overflows. Sits above stretched links (relative z-10) so it stays clickable.
 */
export function ClampedText({ text, className = "" }: { text: string; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || expanded) return;
    const observer = new ResizeObserver(() => setOverflows(el.scrollHeight > el.clientHeight + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, [expanded, text]);

  return (
    <div>
      <p ref={ref} className={`${className} ${expanded ? "" : "line-clamp-2"}`}>
        {text}
      </p>
      {(overflows || expanded) && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="relative z-10 mt-0.5 text-xs font-medium text-teal-dark hover:underline"
        >
          {expanded ? "See less" : "See more"}
        </button>
      )}
    </div>
  );
}
