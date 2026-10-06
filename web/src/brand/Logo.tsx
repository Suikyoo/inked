import { useId } from 'react';

const NIB = 'M24 45L13 24.5C12.6 15.5 17.3 7.6 24 4.3C30.7 7.6 35.4 15.5 35 24.5Z';

/** The slender nib. Small sizes get a larger breather hole and slit so they stay visible. */
export function Logo({ size = 18, color = '#7452E0', title }: { size?: number; color?: string; title?: string }) {
  const id = 'nib-' + useId().replace(/[^a-zA-Z0-9_-]/g, '');
  const small = size < 24;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 48 48"
      role={title ? 'img' : undefined}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      <defs>
        <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width="48" height="48">
          <rect width="48" height="48" fill="#fff" />
          <circle cx="24" cy="21" r={small ? 4 : 3.4} fill="#000" />
          <path d="M24 24V46" stroke="#000" strokeWidth={small ? 2.6 : 1.8} />
        </mask>
      </defs>
      <path d={NIB} fill={color} stroke={color} strokeWidth="1.5" strokeLinejoin="round" mask={`url(#${id})`} />
    </svg>
  );
}

export function Wordmark({ size = 17 }: { size?: number }) {
  return (
    <span className="wordmark" style={{ fontSize: size }}>
      Inked
    </span>
  );
}
