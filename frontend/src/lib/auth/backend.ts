import "server-only";
import { headers } from "next/headers";

const BACKEND_API_URL = (process.env.BACKEND_API_URL ?? "http://localhost:3000").replace(/\/+$/, "");
const REQUEST_TIMEOUT_MS = 10_000;

export interface BackendResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

export interface BackendError {
  status?: string;
  message?: string;
  errors?: { field: string; message: string }[];
}

/**
 * Calls the TruFinity backend from the server. The session token never reaches client JavaScript;
 * the caller's IP and user agent are forwarded so backend rate limiting and audit logs see the real client.
 */
export async function backendFetch<T>(
  path: string,
  init: { method?: "GET" | "POST"; body?: unknown; token?: string } = {},
): Promise<BackendResponse<T>> {
  const incoming = await headers();
  const requestHeaders: Record<string, string> = { Accept: "application/json" };
  if (init.body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (init.token) requestHeaders.Authorization = `Bearer ${init.token}`;
  const forwardedFor = incoming.get("x-forwarded-for");
  if (forwardedFor) requestHeaders["X-Forwarded-For"] = forwardedFor;
  const userAgent = incoming.get("user-agent");
  if (userAgent) requestHeaders["User-Agent"] = userAgent;

  const response = await fetch(`${BACKEND_API_URL}${path}`, {
    method: init.method ?? "GET",
    headers: requestHeaders,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    cache: "no-store",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  let data: T | null = null;
  if (response.status !== 204) {
    data = (await response.json().catch(() => null)) as T | null;
  }
  return { ok: response.ok, status: response.status, data };
}
