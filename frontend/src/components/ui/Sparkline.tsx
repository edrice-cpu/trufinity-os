export function Sparkline({
  data,
  className = "h-8 w-20",
  color = "var(--brand-teal-dark)",
}: {
  data: number[];
  className?: string;
  color?: string;
}) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const step = 100 / (data.length - 1);

  const points = data
    .map((value, i) => {
      const x = i * step;
      const y = 100 - ((value - min) / range) * 100;
      return `${x},${y}`;
    })
    .join(" ");

  return (
    <svg viewBox="0 0 100 100" preserveAspectRatio="none" className={className}>
      <polyline points={points} fill="none" stroke={color} strokeWidth={6} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
