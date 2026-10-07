import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export default function FlaggedItemNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-foreground/40">
        <Icon name="alert-circle" className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-foreground">Flagged item not found</p>
      <p className="text-xs text-foreground/55">This item may have been resolved and archived, or the link is out of date.</p>
      <Link href="/red-flags" className="mt-1 rounded-lg bg-ink px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
        Back to Red Flags
      </Link>
    </div>
  );
}
