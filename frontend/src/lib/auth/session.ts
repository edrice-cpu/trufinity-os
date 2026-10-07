import "server-only";
import { cookies } from "next/headers";
import { backendFetch } from "./backend";

const isProduction = process.env.NODE_ENV === "production";

// The __Host- prefix makes browsers enforce Secure, Path=/ and no Domain; it requires HTTPS, so it is production-only.
export const SESSION_COOKIE_NAME = isProduction ? "__Host-trufinity_session" : "trufinity_session";

export interface SessionUser {
  id: string;
  email: string;
  fullName: string | null;
}

export async function setSessionCookie(token: string, expiresAt: Date): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    expires: expiresAt,
  });
}

/** Expires the cookie with the same attributes it was set with (required for __Host- cookies to be removed). */
export async function clearSessionCookie(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.set(SESSION_COOKIE_NAME, "", {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge: 0,
  });
}

export async function getSessionToken(): Promise<string | undefined> {
  return (await cookies()).get(SESSION_COOKIE_NAME)?.value;
}

/** Validates the session cookie against the backend; returns null when absent, expired, or revoked. */
export async function getCurrentUser(): Promise<SessionUser | null> {
  const token = await getSessionToken();
  if (!token) return null;
  try {
    const response = await backendFetch<{ user?: SessionUser }>("/api/auth/me", { token });
    return response.ok ? (response.data?.user ?? null) : null;
  } catch {
    return null;
  }
}
