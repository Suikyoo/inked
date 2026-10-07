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
  /** Ids of the folders above this note, top-down. */
  folderIds: string[];
  updatedAt: string;
  /** [[Links]] in plus out, each pair of notes counted once. 0 while links are still decrypting. */
  degree: number;
}
export interface SceneFolder {
  id: string;
  vaultId: string;
  x: number;
  y: number;
  name: string;
  /** 0 for a top-level folder. */
  depth: number;
  /** Notes directly inside, the Index excluded. */
  noteCount: number;
  /** Folders directly inside. */
  folderCount: number;
}
export interface SceneHub {
  vaultId: string;
  x: number;
  y: number;
  radius: number;
}
export interface Seg {
  /** Stable key: the child's id for a pencil edge, the two note ids for a link. */
  id: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}
/** A [[link]] between two notes, a and b being their ids. */
export interface LinkSeg extends Seg {
  a: string;
  b: string;
}
/** A hierarchy edge from a parent (hub or folder) to a child. */
export interface PencilSeg extends Seg {
  /** Depth of the parent: 0 for the hub, 1 for a top-level folder, and so on. */
  depth: number;
  kind: 'folder' | 'note';
}
/** World-space geometry for every vault on the map. */
export interface Scene {
  dots: SceneDot[];
  folders: SceneFolder[];
  hubs: SceneHub[];
  pencil: PencilSeg[];
  links: LinkSeg[];
  /** Some vault's note text is still decrypting, so its links are not drawn yet. */
  linksPending: boolean;
  bounds: Bounds;
  vaultBounds: Record<string, Bounds>;
  /** World bounds of each folder and everything below it. */
  folderBounds: Record<string, Bounds>;
  /**
   * Node id -> [hub, folders top-down, node], for ink strokes. Covers notes, folders and Index notes;
   * an Index note's chain ends at its folder (just the hub at the vault root, see rootIndexes).
   */
  chains: Record<string, Pt[]>;
  /** Node id -> the folders its ink chain passes through, top-down (a folder includes itself). */
  chainFolders: Record<string, string[]>;
  /** Root Index note id -> its vault: the hub stands for it. */
  rootIndexes: Record<string, string>;
}

export const UNTITLED = 'Untitled';
export const displayTitle = (title: string) => title.trim() || UNTITLED;

/** Bend of the hierarchy curves, as a share of their length. */
export const HIERARCHY_BEND = 0.12;
/** Bend of the dotted [[link]] curves. */
export const LINK_BEND = 0.25;

const f1 = (n: number) => n.toFixed(1);

/** The control point bowed perpendicular to a → b by `bend` × its length. */
function control(a: Pt, b: Pt, bend: number): Pt {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  return { x: (a.x + b.x) / 2 - dy * bend, y: (a.y + b.y) / 2 + dx * bend };
}
const q = (a: Pt, b: Pt, bend: number) => {
  const c = control(a, b, bend);
  return `Q${f1(c.x)} ${f1(c.y)} ${f1(b.x)} ${f1(b.y)}`;
};

/** One quill curve from a to b. */
export const curvePath = (a: Pt, b: Pt, bend: number) => `M${f1(a.x)} ${f1(a.y)} ${q(a, b, bend)}`;

/** The same curves joined end to end into one path, for an ink stroke. */
export function chainPath(points: Pt[], bend: number): string {
  if (points.length < 2) return '';
  let d = `M${f1(points[0].x)} ${f1(points[0].y)}`;
  for (let i = 1; i < points.length; i++) d += ' ' + q(points[i - 1], points[i], bend);
  return d;
}

/** A [[link]] curve, bowed more than the hierarchy so the two read apart. */
export const linkPath = (a: Pt, b: Pt) => curvePath(a, b, LINK_BEND);

/** Screen-pixel stroke width: hub → top folder 1.5, folder → subfolder 1.1, → note 0.8. */
export const edgeWidth = (s: PencilSeg) => (s.kind === 'note' ? 0.8 : s.depth === 0 ? 1.5 : 1.1);

const seg = (id: string, a: Pt, b: Pt): Seg => ({ id, x1: a.x, y1: a.y, x2: b.x, y2: b.y });
const grow = (b: Bounds | undefined, p: Pt): Bounds =>
  b
    ? { minX: Math.min(b.minX, p.x), minY: Math.min(b.minY, p.y), maxX: Math.max(b.maxX, p.x), maxY: Math.max(b.maxY, p.y) }
    : { minX: p.x, minY: p.y, maxX: p.x, maxY: p.y };

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
    folderBounds: {},
    chains: {},
    chainFolders: {},
    rootIndexes: {},
  };
  let first = true;

  for (const { vaultId, graph, layout } of inputs) {
    const c = centres[vaultId] ?? { x: 0, y: 0 };
    const hub = { x: c.x, y: c.y };
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
      id === null ? hub : at(layout.folders[id] ?? layout.notes[id] ?? { x: 0, y: 0 });
    const folderChain = (folderId: string | null): string[] => {
      const ids: string[] = [];
      for (let id = folderId; id && folderById.has(id); id = folderById.get(id)!.parentId) ids.unshift(id);
      return ids;
    };
    const ink = (id: string, folderIds: string[], end: Pt | null) => {
      scene.chains[id] = [hub, ...folderIds.map((f) => pos(f)), ...(end ? [end] : [])];
      scene.chainFolders[id] = folderIds;
    };
    /** Widens the subtree bounds of every folder in `folderIds` to take in `p`. */
    const cover = (folderIds: string[], p: Pt) => {
      for (const f of folderIds) scene.folderBounds[f] = grow(scene.folderBounds[f], p);
    };

    const notesIn = new Map<string | null, number>();
    for (const n of graph.notes) if (!n.index && layout.notes[n.id]) notesIn.set(n.folderId, (notesIn.get(n.folderId) ?? 0) + 1);
    const foldersIn = new Map<string | null, number>();
    for (const f of graph.folders) if (layout.folders[f.id]) foldersIn.set(f.parentId, (foldersIn.get(f.parentId) ?? 0) + 1);

    for (const f of graph.folders) {
      const p = layout.folders[f.id];
      if (!p) continue;
      const w = at(p);
      scene.folders.push({
        id: f.id,
        vaultId,
        ...w,
        name: f.name,
        depth: f.depth,
        noteCount: notesIn.get(f.id) ?? 0,
        folderCount: foldersIn.get(f.id) ?? 0,
      });
      const ids = folderChain(f.id);
      ink(f.id, ids, null);
      cover(ids, w);
    }
    for (const [id, parent] of Object.entries(layout.parent)) {
      const kind = layout.folders[id] ? 'folder' : 'note';
      const depth = parent === null ? 0 : (folderById.get(parent)?.depth ?? 0) + 1;
      scene.pencil.push({ ...seg(id, pos(parent), pos(id)), depth, kind });
    }

    if (graph.linksReady) {
      const seen = new Set<string>();
      for (const l of graph.links) {
        if (!layout.notes[l.from] || !layout.notes[l.to]) continue;
        const key = l.from < l.to ? `${l.from}|${l.to}` : `${l.to}|${l.from}`;
        if (seen.has(key)) continue;
        seen.add(key);
        scene.links.push({ ...seg(key, pos(l.from), pos(l.to)), a: l.from, b: l.to });
      }
    } else {
      scene.linksPending = true;
    }

    for (const n of graph.notes) {
      const chainIds = folderChain(n.folderId);
      if (n.index) {
        // No dot: a hit on the Index inks the way to the folder that stands for it.
        ink(n.id, chainIds, null);
        if (chainIds.length === 0) scene.rootIndexes[n.id] = vaultId;
        continue;
      }
      const p = layout.notes[n.id];
      if (!p) continue;
      const w = at(p);
      scene.dots.push({
        id: n.id,
        vaultId,
        x: w.x,
        y: w.y,
        title: displayTitle(n.title),
        folderIds: chainIds,
        folderPath: chainIds.map((id) => folderById.get(id)!.name).join(' / '),
        updatedAt: n.updatedAt,
        degree: 0,
      });
      ink(n.id, chainIds, w);
      cover(chainIds, w);
    }
  }
  const degree = new Map<string, number>();
  for (const l of scene.links) {
    degree.set(l.a, (degree.get(l.a) ?? 0) + 1);
    degree.set(l.b, (degree.get(l.b) ?? 0) + 1);
  }
  for (const d of scene.dots) d.degree = degree.get(d.id) ?? 0;
  return scene;
}

/** Radius of the selection ring, pushed out past the density rings. */
export const selRingRadius = (degree: number) => (degree >= 3 ? 11.5 : degree === 2 ? 9 : 7);
/** 'hollow' for an orphan, 'r1' for two links, 'r2' for three or more, '' for one. */
export const densityClass = (degree: number): 'hollow' | '' | 'r1' | 'r2' => (degree === 0 ? 'hollow' : degree === 1 ? '' : degree === 2 ? 'r1' : 'r2');

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
