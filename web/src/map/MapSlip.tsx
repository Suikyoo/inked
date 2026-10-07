import { useLayoutEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { relativeTime } from '../lib/util';
import type { SceneDot } from './scene';
import type { Size } from './useViewport';

const W = 220;
/** Used until the slip has been measured. */
const H = 96;
const PAD = 8;

/** Card for the selected dot, kept inside the map frame. */
export function MapSlip({ dot, x, y, frame, href, now }: { dot: SceneDot; x: number; y: number; frame: Size; href: string; now: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [h, setH] = useState(H);
  useLayoutEffect(() => {
    const m = ref.current?.offsetHeight;
    if (m && m !== h) setH(m);
  });
  const left = Math.max(PAD, Math.min(x + 12, frame.w - W - PAD));
  const top = Math.max(PAD, Math.min(y - 20, frame.h - h - PAD));
  return (
    <div ref={ref} className="cmap-slip" style={{ left, top }} role="group" aria-label="Selected note">
      <div className="cmap-slip-title">{dot.title}</div>
      <div className="cmap-slip-path">{dot.folderPath || 'Vault root'}</div>
      <div className="cmap-slip-meta">
        edited {relativeTime(dot.updatedAt, now)} · {dot.links} {dot.links === 1 ? 'link' : 'links'}
      </div>
      <Link className="cmap-slip-open" to={href}>
        Open note →
      </Link>
    </div>
  );
}
