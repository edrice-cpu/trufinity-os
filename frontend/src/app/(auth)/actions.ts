"use server";

import { redirect } from "next/navigation";
import { backendFetch, type BackendError } from "@/lib/auth/backend";
import { clearSessionCookie, getSessionToken, setSessionCookie } from "@/lib/auth/session";
import {
  forgotPasswordSchema,
  loginSchema,
  resetPasswordSchema,
  safeRedirectPath,
  toFieldErrors,
  type FieldErrors,
} from "@/lib/auth/validation";

export interface AuthFormState {
  status: "idle" | "error" | "success";
  message?: string;
  fieldErrors?: FieldErrors;
  /** Echoed back so the email field keeps its value after a failed submit (passwords are never echoed). */
  email?: string;
}

const UNAVAILABLE_MESSAGE = "We couldn't reach the server. Please try again in a moment.";

const formString = (formData: FormData, key: string): string => {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
};

const errorFromResponse = (status: number, data: BackendError | null, fallback: string): AuthFormState => {
  if (status === 429) {
    return { status: "error", message: data?.message ?? "Too many attempts. Please try again later." };
  }
  if (status === 400 && data?.errors?.length) {
    return {
      status: "error",
      message: "Please correct the highlighted fields.",
      fieldErrors: Object.fromEntries(data.errors.map((e) => [e.field || "form", e.message])),
    };
  }
  return { status: "error", message: status >= 500 ? UNAVAILABLE_MESSAGE : (data?.message ?? fallback) };
};

export async function loginAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = formString(formData, "email");
  const parsed = loginSchema.safeParse({ email, password: formString(formData, "password") });
  if (!parsed.success) return { status: "error", fieldErrors: toFieldErrors(parsed.error), email };

  let response;
  try {
    response = await backendFetch<{ token?: string; expiresAt?: string } & BackendError>("/api/auth/login", {
      method: "POST",
      body: parsed.data,
    });
  } catch {
    return { status: "error", message: UNAVAILABLE_MESSAGE, email };
  }

  if (!response.ok || !response.data?.token || !response.data.expiresAt) {
    return { ...errorFromResponse(response.status, response.data, "Invalid email or password."), email };
  }

  await setSessionCookie(response.data.token, new Date(response.data.expiresAt));
  // redirect() throws, so it must stay outside try/catch.
  redirect(safeRedirectPath(formData.get("next")));
}

export async function forgotPasswordAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const email = formString(formData, "email");
  const parsed = forgotPasswordSchema.safeParse({ email });
  if (!parsed.success) return { status: "error", fieldErrors: toFieldErrors(parsed.error), email };

  try {
    const response = await backendFetch<BackendError>("/api/auth/forgot-password", {
      method: "POST",
      body: parsed.data,
    });
    if (!response.ok) return { ...errorFromResponse(response.status, response.data, UNAVAILABLE_MESSAGE), email };
    return {
      status: "success",
      message: response.data?.message ?? "If an account exists for that email, a password reset link has been sent.",
    };
  } catch {
    return { status: "error", message: UNAVAILABLE_MESSAGE, email };
  }
}

export async function resetPasswordAction(_prev: AuthFormState, formData: FormData): Promise<AuthFormState> {
  const parsed = resetPasswordSchema.safeParse({
    token: formString(formData, "token"),
    password: formString(formData, "password"),
    confirmPassword: formString(formData, "confirmPassword"),
  });
  if (!parsed.success) {
    const fieldErrors = toFieldErrors(parsed.error);
    return { status: "error", fieldErrors, ...(fieldErrors.token ? { message: fieldErrors.token } : {}) };
  }

  try {
    const response = await backendFetch<BackendError>("/api/auth/reset-password", {
      method: "POST",
      body: { token: parsed.data.token, password: parsed.data.password },
    });
    if (!response.ok) {
      return errorFromResponse(
        response.status,
        response.data,
        "This password reset link is invalid or has expired. Please request a new one.",
      );
    }
  } catch {
    return { status: "error", message: UNAVAILABLE_MESSAGE };
  }

  redirect("/login?reset=success");
}

export async function logoutAction(): Promise<void> {
  const token = await getSessionToken();
  if (token) {
    try {
      // Revoke server-side so the token is useless even if it was copied elsewhere.
      await backendFetch("/api/auth/logout", { method: "POST", token });
    } catch {
      // Still clear the local session if the backend is unreachable; the token expires on its own.
    }
  }
  await clearSessionCookie();
  redirect("/login?signed_out=1");
}
