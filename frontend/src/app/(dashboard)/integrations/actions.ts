"use server";

import { refresh } from "next/cache";
import { redirect } from "next/navigation";
import { backendFetch } from "@/lib/auth/backend";
import { getSessionToken } from "@/lib/auth/session";

/** Asks the backend for a single-use Intuit authorization URL and sends the browser there. */
export async function connectQuickBooksAction(): Promise<void> {
  const token = await getSessionToken();
  if (!token) redirect("/login?next=/integrations");

  let authorizationUrl: string | undefined;
  let unauthenticated = false;
  try {
    const response = await backendFetch<{ authorizationUrl?: string }>("/api/integrations/quickbooks/connect", {
      method: "POST",
      token,
    });
    unauthenticated = response.status === 401;
    authorizationUrl = response.ok ? response.data?.authorizationUrl : undefined;
  } catch {
    authorizationUrl = undefined;
  }

  // redirect() throws, so all redirects happen outside the try/catch.
  if (unauthenticated) redirect("/login?next=/integrations");
  // Only ever send users to an HTTPS Intuit URL, even if the backend response were tampered with.
  if (!authorizationUrl || !isIntuitUrl(authorizationUrl)) redirect("/integrations?quickbooks=failed");
  redirect(authorizationUrl);
}

/** Re-renders the page so connection status is re-checked against the providers. */
export async function refreshStatusAction(): Promise<void> {
  refresh();
}

function isIntuitUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "intuit.com" || url.hostname.endsWith(".intuit.com"));
  } catch {
    return false;
  }
}
