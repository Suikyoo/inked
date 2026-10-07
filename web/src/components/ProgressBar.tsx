export function ProgressBar({ value, max, label, id }: { value: number; max: number; label: string; id?: string }) {
  const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
  return (
    <div className="progress" id={id}>
      <div className="bar" role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={max} aria-valuenow={value}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="progress-label">{label}</span>
    </div>
  );
}
