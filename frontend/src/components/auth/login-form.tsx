"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, type AuthFormState } from "@/app/(auth)/actions";
import { authLinkClassName, FormAlert, PasswordField, SubmitButton, TextField } from "./form-controls";

const initialState: AuthFormState = { status: "idle" };

export function LoginForm({ next, notice }: { next: string; notice?: string | undefined }) {
  const [state, formAction, pending] = useActionState(loginAction, initialState);

  return (
    <form action={formAction} noValidate className="flex flex-col gap-5">
      {state.message ? (
        <FormAlert tone="error">{state.message}</FormAlert>
      ) : (
        notice && <FormAlert tone="success">{notice}</FormAlert>
      )}

      <input type="hidden" name="next" value={next} />

      <TextField
        label="Email"
        name="email"
        type="email"
        icon="mail"
        placeholder="you@trufinity.ca"
        inputMode="email"
        autoComplete="username"
        autoCapitalize="none"
        spellCheck={false}
        required
        autoFocus
        defaultValue={state.email}
        error={state.fieldErrors?.email}
        disabled={pending}
      />

      <div className="flex flex-col gap-2">
        <PasswordField
          label="Password"
          name="password"
          autoComplete="current-password"
          required
          error={state.fieldErrors?.password}
          disabled={pending}
        />
        <Link href="/forgot-password" className={`self-end text-sm ${authLinkClassName}`}>
          Forgot password?
        </Link>
      </div>

      <SubmitButton pending={pending} pendingLabel="Signing in…">
        Sign in
      </SubmitButton>
    </form>
  );
}
