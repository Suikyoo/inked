import { useCallback, useEffect, useRef, useState } from 'react';
import type { Pt } from './layout';

/** screen = world * scale + t */
export interface View {
  scale: number;
  tx: number;
  ty: number;
}
export interface Bounds {
  minX: number;
  minY: number;
  maxX: number;
  maxY: number;
}
export interface Size {
  w: number;
  h: number;
}

export const MIN_SCALE = 0.4;
export const MAX_SCALE = 4;
const ANIM_MS = 200;

export const clampScale = (s: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
export const toScreen = (v: View, p: Pt): Pt => ({ x: p.x * v.scale + v.tx, y: p.y * v.scale + v.ty });
export const toWorld = (v: View, p: Pt): Pt => ({ x: (p.x - v.tx) / v.scale, y: (p.y - v.ty) / v.scale });

/** Zoom by `factor` around screen point (px, py), which stays put. */
export function zoomAt(v: View, factor: number, px: number, py: number): View {
  const scale = clampScale(v.scale * factor);
  const k = scale / v.scale;
  return { scale, tx: px - (px - v.tx) * k, ty: py - (py - v.ty) * k };
}

export const panBy = (v: View, dx: number, dy: number): View => ({ scale: v.scale, tx: v.tx + dx, ty: v.ty + dy });

/** The view that centres `b` in `size`, as large as the padding and the scale limits allow. */
export function fit(b: Bounds, size: Size, padding = 24): View {
  const bw = Math.max(1, b.maxX - b.minX);
  const bh = Math.max(1, b.maxY - b.minY);
  const scale = clampScale(Math.min((size.w - 2 * padding) / bw, (size.h - 2 * padding) / bh));
  const cx = (b.minX + b.maxX) / 2;
  const cy = (b.minY + b.maxY) / 2;
  return { scale, tx: size.w / 2 - cx * scale, ty: size.h / 2 - cy * scale };
}

export const lerpView = (a: View, b: View, t: number): View => ({
  scale: a.scale + (b.scale - a.scale) * t,
  tx: a.tx + (b.tx - a.tx) * t,
  ty: a.ty + (b.ty - a.ty) * t,
});

function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function useViewport(initial: View | (() => View)) {
  const [view, setRaw] = useState<View>(initial);
  const current = useRef(view);
  current.current = view;
  const frame = useRef(0);

  const stop = useCallback(() => {
    if (frame.current) cancelAnimationFrame(frame.current);
    frame.current = 0;
  }, []);

  const setView = useCallback(
    (next: View | ((v: View) => View)) => {
      stop();
      setRaw(next);
    },
    [stop],
  );

  const animateTo = useCallback(
    (target: View) => {
      stop();
      if (reducedMotion() || typeof requestAnimationFrame !== 'function') {
        setRaw(target);
        return;
      }
      const from = current.current;
      const t0 = performance.now();
      const step = (t: number) => {
        const k = Math.min(1, (t - t0) / ANIM_MS);
        setRaw(lerpView(from, target, 1 - (1 - k) ** 3));
        frame.current = k < 1 ? requestAnimationFrame(step) : 0;
      };
      frame.current = requestAnimationFrame(step);
    },
    [stop],
  );

  useEffect(() => stop, [stop]);
  return { view, setView, animateTo };
}
