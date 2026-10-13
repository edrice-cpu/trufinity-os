"use server";

import { redirect } from "next/navigation";
import { backendFetch, type BackendError } from "@/lib/auth/backend";
import { getSessionToken } from "@/lib/auth/session";

const LOGIN_PATH = "/login?next=/escalations";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Only ok/message go back to the browser — the work item itself is re-read by router.refresh() on the server.
interface ActionResult {
  ok: boolean;
  message?: string;
}

/**
 * POSTs one work-item transition. `redirect()` throws, so it is only ever called outside the try/catch;
 * otherwise an expired session would be swallowed and shown as "Unable to reach the backend."
 */
async function postWorkItem(
  id: string,
  action: "acknowledge" | "resolve" | "not-a-problem",
  body: Record<string, string> | undefined,
  messages: { notFound: string; failed: string },
): Promise<ActionResult> {
  const token = await getSessionToken();
  if (!token) redirect(LOGIN_PATH);
  // Ids arrive from the browser; never interpolate anything that isn't a UUID into the backend path.
  if (!UUID_PATTERN.test(id)) return { ok: false, message: messages.notFound };

  let response: Awaited<ReturnType<typeof backendFetch<BackendError>>>;
  try {
    response = await backendFetch<BackendError>(`/api/google/work-items/${id}/${action}`, {
      method: "POST",
      body: body ?? {},
      token,
    });
  } catch {
    return { ok: false, message: "Unable to reach the backend." };
  }

  if (response.status === 401) redirect(LOGIN_PATH);
  if (response.status === 404) return { ok: false, message: messages.notFound };
  if (!response.ok) {
    return { ok: false, message: response.data?.errors?.[0]?.message ?? response.data?.message ?? messages.failed };
  }
  return { ok: true };
}

export async function acknowledgeWorkItemAction(id: string): Promise<ActionResult> {
  return postWorkItem(id, "acknowledge", undefined, {
    notFound: "Work item not found.",
    failed: "Failed to acknowledge work item.",
  });
}

// One-tap "not a problem" feedback (spec 6.4) — logged on the backend and used for classifier tuning.
export async function dismissWorkItemAction(id: string): Promise<ActionResult> {
  return postWorkItem(id, "not-a-problem", undefined, {
    notFound: "Work item not found or already closed.",
    failed: "Failed to mark as not a problem.",
  });
}

export async function resolveWorkItemAction(id: string, resolutionNote: string): Promise<ActionResult> {
  const trimmed = typeof resolutionNote === "string" ? resolutionNote.trim() : "";
  if (!trimmed || trimmed.length > 2000) {
    return { ok: false, message: "Resolution note must be 1–2000 characters." };
  }
  return postWorkItem(id, "resolve", { resolution_note: trimmed }, {
    notFound: "Work item not found.",
    failed: "Failed to resolve work item.",
  });
}
