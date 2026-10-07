import type { ReactNode } from "react";
import { redirect } from "next/navigation";
import { DashboardShell } from "@/components/layout/DashboardShell";
import { getCurrentUser } from "@/lib/auth/session";

export default async function DashboardGroupLayout({ children }: { children: ReactNode }) {
  // Every dashboard page requires a valid, unrevoked session.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return <DashboardShell user={user}>{children}</DashboardShell>;
}
