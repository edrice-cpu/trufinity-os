"use client";

import { useLinkStatus } from "next/link";
import { Spinner } from "./States";

/** Place inside a <Link>: shows a spinner while that link's navigation is pending. */
export function LinkPending({ className }: { className?: string }) {
  const { pending } = useLinkStatus();
  return pending ? <Spinner className={className} /> : null;
}
