export type ViewerRole = "owner" | "manager" | "staff";

/**
 * TODO: read the signed-in user's role once the auth API exists. Until then nobody is
 * treated as privileged, so confidential sections stay locked by default.
 */
export async function getViewerRole(): Promise<ViewerRole> {
  return "staff";
}

/** Confidential data (e.g. per-technician sales) is server-rendered only for these roles. */
export async function canViewConfidential(): Promise<boolean> {
  const role = await getViewerRole();
  return role === "owner";
}
