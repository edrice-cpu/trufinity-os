// Shared by server and client components, so it must not live in a "use client" module.
const variants = {
  primary: "bg-brand text-white hover:bg-brand-dark",
  secondary: "border border-border-subtle bg-surface text-foreground hover:bg-surface-muted",
};

export type ButtonVariant = keyof typeof variants;

export const buttonClassName = (variant: ButtonVariant) =>
  `inline-flex h-9 items-center justify-center gap-1.5 rounded-lg px-4 text-sm font-semibold transition ` +
  `focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal-dark ` +
  `disabled:cursor-not-allowed disabled:opacity-60 ${variants[variant]}`;
