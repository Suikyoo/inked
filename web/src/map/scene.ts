import type { VaultGraph } from './graph';
import { layoutWorld, type Pt, type VaultLayout } from './layout';
import type { Bounds } from './useViewport';

export interface SceneInput {
  vaultId: string;
  graph: VaultGraph;
  layout: VaultLayout;
}
export interface SceneDot {
  id: string;
  vaultId: string;
  x: number;
  y: number;
  title: string;
  folderPath: string;
  updatedAt: string;
  links: number;
}
export interface SceneFolder {
  id: string;
  vaultId: string;
  x: number;
  y: number;
  name: string;
}
export interface SceneHub {
  vaultId: string;
  x: number;
  y: number;
  radius: number;
}
export interface Seg {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
/** World-space geometry for every vault on the map. */
export interface Scene {
  dots: SceneDot[];
  folders: SceneFolder[];
  hubs: SceneHub[];
  pencil: Seg[];
  links: Seg[];
  /** Some vault's note text is still decrypting, so its links are not drawn yet. */
  linksPending: boolean;
  bounds: Bounds;
  vaultBounds: Record<string, Bounds>;
  /** Note id -> [hub, folders top-down, note], for ink strokes. */
  chains: Record<string, Pt[]>;
}

export const UNTITLED = 'Untitled';
export const displayTitle = (title: string) => title.trim() || UNTITLED;

const seg = (a: Pt, b: Pt): Seg => ({ x1: a.x, y1: a.y, x2: b.x, y2: b.y });

export function buildScene(inputs: SceneInput[], gap = 48): Scene {
  const centres = layoutWorld(
    inputs.map((i) => i.layout),
    gap,
  );
  const scene: Scene = {
    dots: [],
    folders: [],
    hubs: [],
    pencil: [],
    links: [],
    linksPending: false,
    bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
    vaultBounds: {},
    chains: {},
  };
  let first = true;

  for (const { vaultId, graph, layout } of inputs) {
    const c = centres[vaultId] ?? { x: 0, y: 0 };
    const at = (p: Pt): Pt => ({ x: c.x + p.x, y: c.y + p.y });
    const r = layout.radius;
    scene.hubs.push({ vaultId, x: c.x, y: c.y, radius: r });
    const vb = { minX: c.x - r, minY: c.y - r, maxX: c.x + r, maxY: c.y + r };
    scene.vaultBounds[vaultId] = vb;
    scene.bounds = first
      ? { ...vb }
      : {
          minX: Math.min(scene.bounds.minX, vb.minX),
          minY: Math.min(scene.bounds.minY, vb.minY),
          maxX: Math.max(scene.bounds.maxX, vb.maxX),
          maxY: Math.max(scene.bounds.maxY, vb.maxY),
        };
    first = false;

    const folderById = new Map(graph.folders.map((f) => [f.id, f]));
    const pos = (id: string | null): Pt =>
      id === null ? { x: c.x, y: c.y } : at(layout.folders[id] ?? layout.notes[id] ?? { x: 0, y: 0 });
    const folderChain = (folderId: string | null): string[] => {
      const ids: string[] = [];
      for (let id = folderId; id && folderById.has(id); id = folderById.get(id)!.parentId) ids.unshift(id);
      return ids;
    };

    for (const f of graph.folders) {
      const p = layout.folders[f.id];
      if (p) scene.folders.push({ id: f.id, vaultId, ...at(p), name: f.name });
    }
    for (const [id, parent] of Object.entries(layout.parent)) scene.pencil.push(seg(pos(parent), pos(id)));

    const neighbours = new Map<string, Set<string>>();
    if (graph.linksReady) {
      const seen = new Set<string>();
      for (const l of graph.links) {
        if (!layout.notes[l.from] || !layout.notes[l.to]) continue;
        for (const [a, b] of [
          [l.from, l.to],
          [l.to, l.from],
        ]) {
          if (!neighbours.has(a)) neighbours.set(a, new Set());
          neighbours.get(a)!.add(b);
        }
        const key = l.from < l.to ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scene.links.push(seg(pos(l.from), pos(l.to)));
      }
    } else {
      scene.linksPending = true;
    }

    for (const n of graph.notes) {
      const p = layout.notes[n.id];
      if (!p) continue;
      const w = at(p);
      const chainIds = folderChain(n.folderId);
      scene.dots.push({
        id: n.id,
        vaultId,
        x: w.x,
        y: w.y,
        title: displayTitle(n.title),
        folderPath: chainIds.map((id) => folderById.get(id)!.name).join(' / '),
        updatedAt: n.updatedAt,
        links: neighbours.get(n.id)?.size ?? 0,
      });
      scene.chains[n.id] = [{ x: c.x, y: c.y }, ...chainIds.map((id) => pos(id)), w];
    }
  }
  return scene;
}

/** Closed outline of a stroke along `points`, `w0` wide at the start tapering to `w1`. */
export function taperPath(points: Pt[], w0 = 3, w1 = 0.8): string {
  const pts: Pt[] = [];
  for (const p of points) {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-6) pts.push(p);
  }
  if (pts.length < 2) return '';
  const cum = [0];
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  const total = cum[cum.length - 1];
  const left: Pt[] = [];
  const right: Pt[] = [];
  pts.forEach((p, i) => {
    const a = pts[Math.max(0, i - 1)];
    const b = pts[Math.min(pts.length - 1, i + 1)];
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
    const nx = -(b.y - a.y) / len;
    const ny = (b.x - a.x) / len;
    const half = (w0 + (w1 - w0) * (cum[i] / total)) / 2;
    left.push({ x: p.x + nx * half, y: p.y + ny * half });
    right.push({ x: p.x - nx * half, y: p.y - ny * half });
  });
  return [...left, ...right.reverse()].map((p, i) => `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join('') + 'Z';
}

export type Dir = 'left' | 'right' | 'up' | 'down';
const KEYS: Record<string, Dir> = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' };
const VEC: Record<Dir, Pt> = { left: { x: -1, y: 0 }, right: { x: 1, y: 0 }, up: { x: 0, y: -1 }, down: { x: 0, y: 1 } };

export const arrowDir = (key: string): Dir | null => KEYS[key] ?? null;

/** Nearest candidate within ±45° of `dir` from `from` (screen space, y down). */
export function nearestInDirection(from: Pt, candidates: { id: string; x: number; y: number }[], dir: Dir): string | null {
  const v = VEC[dir];
  let best: string | null = null;
  let bestDist = Infinity;
  for (const c of candidates) {
    const dx = c.x - from.x;
    const dy = c.y - from.y;
    const d = Math.hypot(dx, dy);
    if (d < 1e-6) continue;
    if ((dx * v.x + dy * v.y) / d < Math.SQRT1_2 - 1e-9) continue;
    if (d < bestDist || (d === bestDist && best !== null && c.id < best)) {
      best = c.id;
      bestDist = d;
    }
  }
  return best;
}
