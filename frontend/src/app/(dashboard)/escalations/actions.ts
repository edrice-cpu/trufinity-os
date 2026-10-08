"use server";

import { redirect } from "next/navigation";
import { backendFetch } from "@/lib/auth/backend";
import { getSessionToken } from "@/lib/auth/session";
import type { WorkItem } from "@/lib/api/google";

const LOGIN_PATH = "/login?next=/escalations";

interface ActionResult {
  ok: boolean;
  message?: string;
  data?: WorkItem;
}

export async function acknowledgeWorkItemAction(id: string): Promise<ActionResult> {
  const token = await getSessionToken();
  if (!token) redirect(LOGIN_PATH);

  try {
    const response = await backendFetch<{ data: WorkItem }>(
      `/api/google/work-items/${encodeURIComponent(id)}/acknowledge`,
      { method: "POST", token },
    );
    if (response.status === 401) redirect(LOGIN_PATH);
    if (response.status === 404) return { ok: false, message: "Work item not found." };
    if (!response.ok) {
      const msg = (response.data as unknown as { message?: string } | null)?.message;
      return { ok: false, message: msg ?? "Failed to acknowledge work item." };
    }
    return { ok: true, data: response.data?.data };
  } catch {
    return { ok: false, message: "Unable to reach the backend." };
  }
}

export async function resolveWorkItemAction(id: string, resolutionNote: string): Promise<ActionResult> {
  const token = await getSessionToken();
  if (!token) redirect(LOGIN_PATH);

  const trimmed = resolutionNote.trim();
  if (!trimmed || trimmed.length > 2000) {
    return { ok: false, message: "Resolution note must be 1–2000 characters." };
  }

  try {
    const response = await backendFetch<{ data: WorkItem }>(
      `/api/google/work-items/${encodeURIComponent(id)}/resolve`,
      { method: "POST", body: { resolution_note: trimmed }, token },
    );
    if (response.status === 401) redirect(LOGIN_PATH);
    if (response.status === 404) return { ok: false, message: "Work item not found." };
    if (!response.ok) {
      const errBody = response.data as unknown as { message?: string; errors?: { field: string; message: string }[] } | null;
      const msg = errBody?.errors?.[0]?.message ?? errBody?.message ?? "Failed to resolve work item.";
      return { ok: false, message: msg };
    }
    return { ok: true, data: response.data?.data };
  } catch {
    return { ok: false, message: "Unable to reach the backend." };
  }
}
