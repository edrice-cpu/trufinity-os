"use client";

import { useId, useState, type InputHTMLAttributes } from "react";
import { Icon } from "@/components/ui/Icon";

type IconName = Parameters<typeof Icon>[0]["name"];

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  name: string;
  error?: string | undefined;
  hint?: string;
  icon?: IconName;
}

function describedBy(errorId: string, hintId: string, error?: string, hint?: string): string | undefined {
  const ids = [error ? errorId : null, hint ? hintId : null].filter(Boolean);
  return ids.length > 0 ? ids.join(" ") : undefined;
}

function FieldMessages({ errorId, hintId, error, hint }: { errorId: string; hintId: string; error?: string | undefined; hint?: string | undefined }) {
  return (
    <>
      {hint && !error && (
        <p id={hintId} className="text-xs text-foreground/50">
          {hint}
        </p>
      )}
      {error && (
        <p id={errorId} className="text-xs font-medium text-danger">
          {error}
        </p>
      )}
    </>
  );
}

function InputFrame({ error, icon, children }: { error?: string | undefined; icon?: IconName | undefined; children: React.ReactNode }) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border bg-surface px-3 focus-within:border-teal-dark focus-within:ring-2 focus-within:ring-teal/20 ${
        error ? "border-danger" : "border-border-subtle"
      }`}
    >
      {icon && <Icon name={icon} className="h-4 w-4 shrink-0 text-foreground/40" />}
      {children}
    </div>
  );
}

const inputClassName =
  "w-full bg-transparent py-2.5 text-sm text-foreground outline-none placeholder:text-foreground/35 disabled:cursor-not-allowed disabled:opacity-60";

export function TextField({ label, name, error, hint, icon, className, ...props }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium text-foreground/80">
        {label}
      </label>
      <InputFrame error={error} icon={icon}>
        <input
          id={id}
          name={name}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(errorId, hintId, error, hint)}
          className={`${inputClassName} ${className ?? ""}`}
          {...props}
        />
      </InputFrame>
      <FieldMessages errorId={errorId} hintId={hintId} error={error} hint={hint} />
    </div>
  );
}

export function PasswordField({ label, name, error, hint, icon = "lock", className, ...props }: FieldProps) {
  const id = useId();
  const errorId = `${id}-error`;
  const hintId = `${id}-hint`;
  const [visible, setVisible] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 text-sm">
      <label htmlFor={id} className="font-medium text-foreground/80">
        {label}
      </label>
      <InputFrame error={error} icon={icon}>
        <input
          id={id}
          name={name}
          type={visible ? "text" : "password"}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(errorId, hintId, error, hint)}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={`${inputClassName} ${className ?? ""}`}
          {...props}
        />
        <button
          type="button"
          onClick={() => setVisible((v) => !v)}
          aria-controls={id}
          aria-pressed={visible}
          className="shrink-0 rounded px-1 text-xs font-medium text-foreground/55 hover:text-foreground focus-visible:outline-2 focus-visible:outline-teal-dark"
        >
          {visible ? "Hide" : "Show"}
          <span className="sr-only"> password</span>
        </button>
      </InputFrame>
      <FieldMessages errorId={errorId} hintId={hintId} error={error} hint={hint} />
    </div>
  );
}

export function FormAlert({ tone, children }: { tone: "error" | "success"; children: React.ReactNode }) {
  const toneClass =
    tone === "error"
      ? "border-danger/20 bg-danger-soft text-danger"
      : "border-success/20 bg-success-soft text-success";
  return (
    <div role={tone === "error" ? "alert" : "status"} className={`rounded-lg border px-3 py-2 text-sm ${toneClass}`}>
      {children}
    </div>
  );
}

export function SubmitButton({ pending, children, pendingLabel }: { pending: boolean; children: React.ReactNode; pendingLabel: string }) {
  return (
    <button
      type="submit"
      disabled={pending}
      aria-disabled={pending}
      className="mt-2 flex w-full items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-brand-dark focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand-dark disabled:cursor-not-allowed disabled:opacity-70"
    >
      {pending ? pendingLabel : children}
      {!pending && <Icon name="chevron-right" className="h-4 w-4" />}
    </button>
  );
}

export const authLinkClassName = "font-medium text-teal-dark underline-offset-4 hover:underline";
