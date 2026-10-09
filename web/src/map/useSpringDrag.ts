import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { prefersReducedMotion } from '../motion';
import { displaceScene } from './displace';
import type { Scene } from './scene';
import { stepSprings, type Anchor, type Body } from './springs';

const MAX_FRAME_S = 1 / 30;
export const OFFSETS_KEY = 'inked-map-offsets';

type Saved = Record<string, [number, number]>;

function load(): Map<string, Body> {
  const out = new Map<string, Body>();
  try {
    const raw = JSON.parse(localStorage.getItem(OFFSETS_KEY) ?? '{}') as Saved;
    for (const [id, v] of Object.entries(raw)) {
      if (Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1])) out.set(id, { x: v[0], y: v[1], vx: 0, vy: 0 });
    }
  } catch {
    // Storage blocked or corrupt: start with the plain layout.
  }
  return out;
}

/**
 * Click-and-move for map nodes. A grabbed node is pulled toward the pointer by a Hooke spring (acceleration
 * clamped). On release it keeps the velocity it has and slows at a constant rate until it stops; nothing pulls it
 * back to its layout spot. Grabbing a folder with `tow`
 * ties every descendant to it one way: they keep their place around the folder and travel with it, and push
 * nothing back. Offsets from the layout are kept in this browser's localStorage, never sent anywhere.
 */
export function useSpringDrag(base: Scene) {
  const bodies = useRef<Map<string, Body> | null>(null);
  if (bodies.current === null) bodies.current = load();
  const anchors = useRef(new Map<string, Anchor>());
  const held = useRef<{ id: string; x0: number; y0: number } | null>(null);
  const raf = useRef(0);
  const last = useRef(0);
  const baseRef = useRef(base);
  baseRef.current = base;
  const [frame, setFrame] = useState(0);

  const save = useCallback(() => {
    const out: Saved = {};
    const known = new Set([...baseRef.current.dots.map((d) => d.id), ...baseRef.current.folders.map((f) => f.id)]);
    for (const [id, b] of bodies.current!) {
      if (known.has(id) && Math.hypot(b.x, b.y) > 0.5) out[id] = [Math.round(b.x * 10) / 10, Math.round(b.y * 10) / 10];
    }
    try {
      if (Object.keys(out).length) localStorage.setItem(OFFSETS_KEY, JSON.stringify(out));
      else localStorage.removeItem(OFFSETS_KEY);
    } catch {
      // Not saved; the offsets still hold for this visit.
    }
  }, []);

  const loop = useCallback(
    (t: number) => {
      const dt = Math.min(MAX_FRAME_S, Math.max(0, (t - last.current) / 1000));
      last.current = t;
      const moving = stepSprings(bodies.current!, anchors.current, held.current !== null, dt);
      setFrame((f) => f + 1);
      if (moving) raf.current = requestAnimationFrame(loop);
      else {
        raf.current = 0;
        save();
      }
    },
    [save],
  );
  const wake = useCallback(() => {
    if (raf.current) return;
    last.current = performance.now();
    raf.current = requestAnimationFrame(loop);
  }, [loop]);
  useEffect(
    () => () => {
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = 0;
    },
    [],
  );

  const body = (id: string): Body => {
    let b = bodies.current!.get(id);
    if (!b) {
      b = { x: 0, y: 0, vx: 0, vy: 0 };
      bodies.current!.set(id, b);
    }
    return b;
  };

  /** Starts holding `id`. With `tow`, every descendant of that folder is tied to it. */
  const grab = (id: string, tow: boolean) => {
    const lead = body(id);
    held.current = { id, x0: lead.x, y0: lead.y };
    anchors.current.set(id, { x: lead.x, y: lead.y });
    if (tow) {
      const tie = (child: string) => {
        const b = body(child);
        anchors.current.set(child, { x: b.x - lead.x, y: b.y - lead.y, root: id });
      };
      for (const f of base.folders) if (f.id !== id && base.chainFolders[f.id]?.includes(id)) tie(f.id);
      for (const d of base.dots) if (d.folderIds.includes(id)) tie(d.id);
    }
    wake();
  };
  /** The pointer is this far (world units) from where it grabbed the node. */
  const moveTo = (dx: number, dy: number) => {
    const h = held.current;
    if (!h) return;
    anchors.current.set(h.id, { x: h.x0 + dx, y: h.y0 + dy });
    wake();
  };
  const release = () => {
    const h = held.current;
    held.current = null;
    if (!h) return;
    if (prefersReducedMotion()) {
      // No animation: the node stays where it is and each follower lands beside it.
      const lead = body(h.id);
      lead.vx = lead.vy = 0;
      for (const [id, a] of anchors.current) {
        if (!a.root) continue;
        const b = body(id);
        b.x = lead.x + a.x;
        b.y = lead.y + a.y;
        b.vx = b.vy = 0;
      }
      anchors.current.clear();
      setFrame((f) => f + 1);
      save();
      return;
    }
    // Let go: the node flies off with the velocity it has and slows at a constant rate.
    anchors.current.set(h.id, { x: 0, y: 0, free: true });
    wake();
  };
  const reset = () => {
    bodies.current!.clear();
    anchors.current.clear();
    held.current = null;
    save();
    setFrame((f) => f + 1);
  };

  const scene = useMemo(
    () => (bodies.current!.size === 0 ? base : displaceScene(base, new Map([...bodies.current!].map(([id, b]) => [id, { x: b.x, y: b.y }])))),
    // `frame` is the clock: the bodies are mutated in place.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [base, frame],
  );
  return { scene, grab, moveTo, release, reset, moved: bodies.current.size > 0 };
}
