import { Logo } from "@/components/ui/Logo";

export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <div className="flex min-h-screen bg-surface">
      <div className="flex w-full flex-col justify-center px-6 py-12 sm:px-10 lg:w-[440px] lg:shrink-0 lg:px-14">
        <Logo className="mb-10" />
        {children}
        <p className="mt-8 text-xs text-foreground/40">
          Secure authenticated access. Contact your administrator if you need a login created.
        </p>
      </div>

      <div className="relative hidden flex-1 items-center justify-center overflow-hidden bg-ink lg:flex">
        <div className="absolute -left-24 -top-24 h-80 w-80 rounded-full bg-teal/20 blur-3xl" />
        <div className="absolute -bottom-32 right-0 h-96 w-96 rounded-full bg-brand/20 blur-3xl" />
        <div className="relative z-10 max-w-md px-10 text-center">
          <p className="text-sm font-semibold uppercase tracking-[0.2em] text-teal">Daily Executive Brief</p>
          <h2 className="mt-4 text-3xl font-semibold leading-tight text-white">
            One clear view of your business, every morning.
          </h2>
          <p className="mt-4 text-sm leading-relaxed text-white/60">
            Revenue, red flags, escalations, and marketing performance — pulled together automatically so you
            always know what needs your attention today.
          </p>
        </div>
      </div>
    </div>
  );
}
