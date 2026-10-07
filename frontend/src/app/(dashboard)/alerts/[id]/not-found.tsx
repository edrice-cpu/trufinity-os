import Link from "next/link";
import { Icon } from "@/components/ui/Icon";

export default function AlertNotFound() {
  return (
    <div className="mx-auto flex max-w-md flex-col items-center gap-3 py-20 text-center">
      <span className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted text-foreground/40">
        <Icon name="alert-circle" className="h-5 w-5" />
      </span>
      <p className="text-sm font-medium text-foreground">Alert not found</p>
      <p className="text-xs text-foreground/55">This alert may have been removed, or the link is out of date.</p>
      <Link href="/demand-alerts" className="mt-1 rounded-lg bg-ink px-3.5 py-1.5 text-xs font-medium text-white hover:opacity-90">
        Back to Demand Alerts
      </Link>
    </div>
  );
}
