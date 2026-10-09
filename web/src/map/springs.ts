/** A node's offset from its layout spot, and how fast it is moving (world units, per second). */
export interface Body {
  x: number;
  y: number;
  vx: number;
  vy: number;
}

/**
 * Where a moving body is being pulled. A leader (the grabbed node) is pulled to a fixed point, the pointer.
 * A follower is pulled to `root`'s position plus the vector it had from the root when it was tied, so it travels
 * with the root and keeps its place. The root feels nothing back, and nothing pulls a node toward its layout spot.
 * A `free` body is let go: it keeps its velocity and slows at a constant rate until it stops.
 */
export interface Anchor {
  x: number;
  y: number;
  root?: string;
  free?: boolean;
}

/** Hooke's law, unit mass: a = k·(anchor - x) - c·v, with the acceleration clamped. */
export const SPRING = {
  /** Leader to pointer. */
  k: 120,
  /** Follower to its root. */
  kString: 90,
  /** Damping: a little under critical, so a node overshoots slightly before it settles. */
  c: 14,
  /** Largest acceleration a node may reach, so a long drag cannot fling it. */
  maxAccel: 6000,
  /** A released node slows by this much per second, whatever its speed. */
  decel: 1400,
  /** Fastest a node may travel, so a hard flick cannot throw it off the map. */
  maxSpeed: 1800,
  /** A node this close to its anchor and this slow is at rest. */
  restDist: 0.05,
  restSpeed: 0.1,
  /** Integration sub-step. */
  maxStep: 1 / 120,
};

const clampMag = (ax: number, ay: number, max: number): [number, number] => {
  const m = Math.hypot(ax, ay);
  return m > max ? [(ax / m) * max, (ay / m) * max] : [ax, ay];
};

const target = (a: Anchor, bodies: Map<string, Body>): { x: number; y: number } => {
  const r = a.root === undefined ? undefined : bodies.get(a.root);
  return r ? { x: r.x + a.x, y: r.y + a.y } : a;
};

/**
 * Advances every anchored body by `dt` seconds; bodies without an anchor stay where they are.
 * Returns true while anything still moves or `held` is set. Once everything has settled the anchors are emptied
 * and the bodies keep their offsets.
 */
export function stepSprings(bodies: Map<string, Body>, anchors: Map<string, Anchor>, held: boolean, dt: number): boolean {
  const n = Math.max(1, Math.ceil(dt / SPRING.maxStep));
  const h = dt / n;
  for (let s = 0; s < n; s++) {
    const acc = new Map<string, [number, number]>();
    for (const [id, a] of anchors) {
      const b = bodies.get(id);
      if (!b) continue;
      if (a.free) {
        // Constant slowing against the direction of travel, never past a stop.
        const m = Math.hypot(b.vx, b.vy);
        const dv = SPRING.decel * h;
        const ox = b.vx;
        const oy = b.vy;
        if (m <= dv) b.vx = b.vy = 0;
        else {
          b.vx -= (b.vx / m) * dv;
          b.vy -= (b.vy / m) * dv;
        }
        // Mean of the speed before and after the step: exact for a constant rate.
        b.x += ((ox + b.vx) / 2) * h;
        b.y += ((oy + b.vy) / 2) * h;
        continue;
      }
      const t = target(a, bodies);
      const k = a.root === undefined ? SPRING.k : SPRING.kString;
      acc.set(id, clampMag(k * (t.x - b.x) - SPRING.c * b.vx, k * (t.y - b.y) - SPRING.c * b.vy, SPRING.maxAccel));
    }
    for (const [id, [ax, ay]] of acc) {
      const b = bodies.get(id)!;
      b.vx += ax * h;
      b.vy += ay * h;
      const m = Math.hypot(b.vx, b.vy);
      if (m > SPRING.maxSpeed) {
        b.vx = (b.vx / m) * SPRING.maxSpeed;
        b.vy = (b.vy / m) * SPRING.maxSpeed;
      }
      b.x += b.vx * h;
      b.y += b.vy * h;
    }
  }
  if (held) return true;
  for (const [id, a] of anchors) {
    const b = bodies.get(id);
    if (!b) continue;
    if (a.free) {
      if (Math.hypot(b.vx, b.vy) > 0) return true;
      continue;
    }
    const t = target(a, bodies);
    if (Math.hypot(t.x - b.x, t.y - b.y) > SPRING.restDist || Math.hypot(b.vx, b.vy) > SPRING.restSpeed) return true;
  }
  anchors.clear();
  return false;
}
