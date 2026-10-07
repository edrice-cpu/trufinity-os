"use client";

import Link from "next/link";
import { useActionState, useSyncExternalStore } from "react";
import { resetPasswordAction, type AuthFormState } from "@/app/(auth)/actions";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/validation";
import { authLinkClassName, FormAlert, PasswordField, SubmitButton } from "./form-controls";

const initialState: AuthFormState = { status: "idle" };

// The reset token arrives in the URL fragment (#token=...), which browsers never send to servers or in Referer headers.
const subscribeToHash = (onChange: () => void) => {
  window.addEventListener("hashchange", onChange);
  return () => window.removeEventListener("hashchange", onChange);
};
const readTokenFromHash = () => /^#token=([A-Za-z0-9_-]{43})$/.exec(window.location.hash)?.[1] ?? "";
const readTokenOnServer = () => null;

const linkClassName = `text-center text-sm ${authLinkClassName}`;

export function ResetPasswordForm() {
  const token = useSyncExternalStore(subscribeToHash, readTokenFromHash, readTokenOnServer);
  const [state, formAction, pending] = useActionState(resetPasswordAction, initialState);

  if (token === null) {
    return <p className="text-sm text-foreground/60">Loading…</p>;
  }

  if (!token) {
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="error">This password reset link is invalid or incomplete.</FormAlert>
        <Link href="/forgot-password" className={linkClassName}>
          Request a new reset link
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      {state.message && (
        <FormAlert tone="error">
          {state.message}{" "}
          <Link href="/forgot-password" className="font-medium underline underline-offset-4">
            Request a new link
          </Link>
        </FormAlert>
      )}

      <input type="hidden" name="token" value={token} />

      <PasswordField
        label="New password"
        name="password"
        autoComplete="new-password"
        required
        autoFocus
        minLength={PASSWORD_MIN_LENGTH}
        maxLength={PASSWORD_MAX_LENGTH}
        hint={`At least ${PASSWORD_MIN_LENGTH} characters. A passphrase of several words works well.`}
        error={state.fieldErrors?.password}
        disabled={pending}
      />

      <PasswordField
        label="Confirm new password"
        name="confirmPassword"
        autoComplete="new-password"
        required
        maxLength={PASSWORD_MAX_LENGTH}
        error={state.fieldErrors?.confirmPassword}
        disabled={pending}
      />

      <SubmitButton pending={pending} pendingLabel="Updating password…">
        Reset password
      </SubmitButton>

      <Link href="/login" className={linkClassName}>
        Back to sign in
      </Link>
    </form>
  );
}
