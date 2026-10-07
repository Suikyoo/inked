export function ProgressBar({ value, max, label, id }: { value: number; max: number; label: string; id?: string }) {
  const num = (n: number) => (Number.isFinite(n) ? n : 0);
  const top = Math.max(0, num(max));
  const now = Math.min(top, Math.max(0, num(value)));
  const pct = top > 0 ? (now / top) * 100 : 0;
  return (
    <div className="progress" id={id}>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={top} aria-valuenow={now}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">{label}</span>
    </div>
  );
}
