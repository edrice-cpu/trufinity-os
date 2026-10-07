"use client";

import { useFormStatus } from "react-dom";
import { buttonClassName, type ButtonVariant } from "./button-styles";

/** Submit button that disables itself while its parent form's Server Action runs. */
export function FormButton({
  children,
  pendingLabel,
  variant = "primary",
  disabled = false,
}: {
  children: React.ReactNode;
  pendingLabel: string;
  variant?: ButtonVariant;
  disabled?: boolean;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={disabled || pending} aria-disabled={disabled || pending} className={buttonClassName(variant)}>
      {pending ? pendingLabel : children}
    </button>
  );
}
