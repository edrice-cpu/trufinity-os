export function AuthCard({ title, description, children }: { title: string; description: string; children: React.ReactNode }) {
  return (
    <section>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
      <p className="mt-2 text-sm text-foreground/55">{description}</p>
      <div className="mt-8">{children}</div>
    </section>
  );
}
