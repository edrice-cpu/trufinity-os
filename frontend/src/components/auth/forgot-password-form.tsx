"use client";

import Link from "next/link";
import { useActionState } from "react";
import { forgotPasswordAction, type AuthFormState } from "@/app/(auth)/actions";
import { authLinkClassName, FormAlert, SubmitButton, TextField } from "./form-controls";

const initialState: AuthFormState = { status: "idle" };

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useActionState(forgotPasswordAction, initialState);

  if (state.status === "success") {
    return (
      <div className="flex flex-col gap-5">
        <FormAlert tone="success">{state.message}</FormAlert>
        <p className="text-sm text-foreground/60">
          The link expires shortly and can only be used once. Didn&apos;t get an email? Check your spam folder or try
          again in a few minutes.
        </p>
        <Link href="/login" className={`text-center text-sm ${authLinkClassName}`}>
          Back to sign in
        </Link>
      </div>
    );
  }

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      {state.message && <FormAlert tone="error">{state.message}</FormAlert>}

      <TextField
        label="Email"
        name="email"
        type="email"
        icon="mail"
        placeholder="you@trufinity.ca"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="none"
        spellCheck={false}
        required
        autoFocus
        defaultValue={state.email}
        error={state.fieldErrors?.email}
        disabled={pending}
      />

      <SubmitButton pending={pending} pendingLabel="Sending link…">
        Send reset link
      </SubmitButton>

      <Link href="/login" className={`text-center text-sm ${authLinkClassName}`}>
        Back to sign in
      </Link>
    </form>
  );
}
