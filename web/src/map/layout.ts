import type { GraphFolder, GraphNote, VaultGraph } from './graph';

export interface Pt {
  x: number;
  y: number;
}

/** Vault-local positions; the hub sits at (0,0). */
export interface VaultLayout {
  vaultId: string;
  /** Hub to farthest dot, plus room for its label. */
  radius: number;
  folders: Record<string, Pt>;
  notes: Record<string, Pt>;
  /** Folder or note id -> parent folder id, or null for the hub. */
  parent: Record<string, string | null>;
}

/** Hub to the top-level folders and the first root-note row. */
export const R0 = 70;
/** Minimum folder to child-folder distance. */
export const RSTEP = 70;
/** Folder to its first note row. */
export const NR = 26;
/** Between note rows; at least MIN_GAP plus the radial jitter both rows can lose. */
export const NSTEP = 15;
/** Minimum distance between any two notes under one parent. */
export const MIN_GAP = 10;
/** Most a note drifts in or out of its row. */
export const JITTER_R = 2.5;
/** Room past the farthest dot for its label. */
export const LABEL_MARGIN = 28;
/** Most a row's angular spacing may be, in multiples of the MIN_GAP step, so notes cluster at their folder. */
export const NOTE_SPREAD = 2;
/** Angle left free at the top of the circle, where the hub name sits. */
export const HUB_GAP = Math.PI / 3;
/** Seed rows start this much tighter than MIN_GAP; relaxation spreads them apart into an irregular pack. */
const SEED = 0.7;
/** Most relaxation steps per folder, and the biggest folder relaxed (a larger one keeps its seed rows). */
const RELAX_STEPS = 120;
const RELAX_MAX = 400;
const MIN_RADIUS = 60;
const START = -Math.PI / 2 + HUB_GAP / 2;

/** Angle between neighbours a chord of MIN_GAP apart at the innermost radius a row can drift to. */
const minStep = (r: number) => 2 * Math.asin(Math.min(1, (SEED * MIN_GAP) / (2 * Math.max(1, r - JITTER_R))));

/** Stable value in [-1, 1) from an id and a salt, so a dot's drift never changes between renders. */
function unit(id: string, salt: number): number {
  let h = 2166136261 ^ salt;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  return ((h >>> 0) / 4294967296) * 2 - 1;
}

const polar = (r: number, a: number): Pt => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const tie = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a: GraphFolder, b: GraphFolder) => a.name.localeCompare(b.name) || tie(a, b);
const byTitle = (a: GraphNote, b: GraphNote) => a.title.localeCompare(b.title) || tie(a, b);

/** Rows for `count` notes spread across an angular `span`, the first at hub radius `r0`. */
export function noteRows(count: number, span: number, r0: number): { r: number; n: number }[] {
  const rows: { r: number; n: number }[] = [];
  for (let left = count, k = 0; left > 0; k++) {
    const r = r0 + k * NSTEP * SEED;
    const n = Math.min(left, Math.max(1, Math.floor(span / minStep(r) + 1e-9)));
    rows.push({ r, n });
    left -= n;
  }
  return rows;
}

/** How a folder's notes are seeded: concentric rows, or a sunflower spiral filling the slice. Both are then relaxed. */
export type NoteStyle = 'rows' | 'sunflower';
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

export function layoutVault(graph: VaultGraph, style: NoteStyle = 'sunflower'): VaultLayout {
  const kids = new Map<string | null, GraphFolder[]>();
  for (const f of graph.folders) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f]);
  for (const list of kids.values()) list.sort(byName);
  const notesIn = new Map<string | null, GraphNote[]>();
  // An Index note has no dot: its folder (or the hub) stands for it.
  for (const n of graph.notes) if (!n.index) notesIn.set(n.folderId, [...(notesIn.get(n.folderId) ?? []), n]);
  for (const list of notesIn.values()) list.sort(byTitle);

  // Folders only, so a new note never resizes another folder's slice.
  const weights = new Map<string, number>();
  const weight = (f: GraphFolder): number => {
    let w = weights.get(f.id);
    if (w === undefined) {
      w = 1 + (kids.get(f.id) ?? []).reduce((s, c) => s + weight(c), 0);
      weights.set(f.id, w);
    }
    return w;
  };

  const out: VaultLayout = { vaultId: graph.vaultId, radius: 0, folders: {}, notes: {}, parent: {} };
  let far = 0;

  /**
   * Pushes one folder's dots apart until none are closer than MIN_GAP, pulling each weakly back to its seed spot,
   * and keeps them inside the folder's slice and outside its first ring. Only that folder's dots move, so a new note
   * never shifts another folder. Returns the radius of the outermost dot.
   */
  const relax = (list: GraphNote[], a0: number, span: number, r0: number): number => {
    const n = list.length;
    const pts = list.map((l) => ({ ...out.notes[l.id] }));
    const home = list.map((l) => ({ ...out.notes[l.id] }));
    if (n > 1 && n <= RELAX_MAX) {
      const G = MIN_GAP * 1.08; // a little over, so a stopped relaxation still keeps MIN_GAP
      const D2 = G * G;
      for (let it = 0; it < RELAX_STEPS; it++) {
        let worst = 0;
        for (let i = 0; i < n; i++) {
          for (let j = i + 1; j < n; j++) {
            const dx = pts[j].x - pts[i].x;
            const dy = pts[j].y - pts[i].y;
            const d2 = dx * dx + dy * dy;
            if (d2 >= D2) continue;
            // Two dots on one spot are split along a stable direction.
            const d = Math.sqrt(d2) || 1e-6;
            const ux = d2 ? dx / d : Math.cos(i * 2.4);
            const uy = d2 ? dy / d : Math.sin(i * 2.4);
            const push = (G - d) / 2;
            worst = Math.max(worst, G - d);
            pts[i].x -= ux * push;
            pts[i].y -= uy * push;
            pts[j].x += ux * push;
            pts[j].y += uy * push;
          }
        }
        for (let i = 0; i < n; i++) {
          pts[i].x += (home[i].x - pts[i].x) * 0.015;
          pts[i].y += (home[i].y - pts[i].y) * 0.015;
          // Back inside the slice (an edge dot keeps half a gap clear of the next folder) and outside the first ring.
          let r = Math.hypot(pts[i].x, pts[i].y);
          const edge = MIN_GAP / 2 / Math.max(1, r);
          let a = Math.atan2(pts[i].y, pts[i].x);
          const rel = Math.atan2(Math.sin(a - a0), Math.cos(a - a0));
          const lo = Math.min(edge, span / 2);
          const hi = Math.max(span - edge, span / 2);
          const clamped = Math.min(hi, Math.max(lo, rel < -Math.PI / 2 ? 0 : rel));
          a = a0 + clamped;
          r = Math.max(r0 - JITTER_R, r);
          pts[i].x = r * Math.cos(a);
          pts[i].y = r * Math.sin(a);
        }
        if (it > 8 && worst < 0.02) break;
      }
    }
    let outer = 0;
    list.forEach((l, i) => {
      out.notes[l.id] = pts[i];
      outer = Math.max(outer, Math.hypot(pts[i].x, pts[i].y));
    });
    return outer;
  };

  const placeNotes = (list: GraphNote[], parent: string | null, a0: number, span: number, r0: number): number => {
    let i = 0;
    let outer = 0;
    const centre = a0 + span / 2;
    if (style === 'sunflower') {
      // A Vogel spiral: even density, no rows. Its disc sits just past the folder along the slice centre.
      const c = MIN_GAP * 0.95;
      const reach = c * Math.sqrt(list.length + 0.5);
      const mid = polar(r0 + reach, centre);
      list.forEach((note, k) => {
        const rho = c * Math.sqrt(k + 0.5);
        const th = k * GOLDEN + centre;
        out.notes[note.id] = { x: mid.x + rho * Math.cos(th), y: mid.y + rho * Math.sin(th) };
        out.parent[note.id] = parent;
      });
      outer = relax(list, a0, span, r0);
      far = Math.max(far, outer);
      return outer;
    }
    for (const row of noteRows(list.length, span, r0)) {
      // Clustered around the slice centre; never wider than the slice.
      const spacing = Math.min(span / row.n, NOTE_SPREAD * minStep(row.r));
      // Two neighbours each drifting `amp` still keep minStep apart.
      const amp = Math.max(0, spacing - minStep(row.r)) / 2;
      for (let j = 0; j < row.n; j++, i++) {
        const id = list[i].id;
        out.notes[id] = polar(row.r + unit(id, 1) * JITTER_R, centre + (j - (row.n - 1) / 2) * spacing + unit(id, 2) * amp);
        out.parent[list[i].id] = parent;
      }
    }
    outer = relax(list, a0, span, r0);
    far = Math.max(far, outer);
    return outer;
  };

  const placeFolder = (f: GraphFolder, a0: number, span: number, r: number) => {
    out.folders[f.id] = polar(r, a0 + span / 2);
    out.parent[f.id] = f.parentId;
    far = Math.max(far, r);
    const outer = placeNotes(notesIn.get(f.id) ?? [], f.id, a0, span, r + NR);
    const childR = Math.max(r + RSTEP, outer + NR);
    const children = kids.get(f.id) ?? [];
    const total = children.reduce((s, c) => s + weight(c), 0);
    let a = a0;
    for (const c of children) {
      const s = (span * weight(c)) / total;
      placeFolder(c, a, s, childR);
      a += s;
    }
  };

  const top = kids.get(null) ?? [];
  const rootNotes = notesIn.get(null) ?? [];
  // The root slice (weight 1) is always reserved, so the first root note moves nothing.
  const total = top.reduce((s, f) => s + weight(f), 0) + 1;
  const circle = 2 * Math.PI - HUB_GAP;
  let a = START;
  const rootSpan = circle / total;
  placeNotes(rootNotes, null, a, rootSpan, R0);
  a += rootSpan;
  for (const f of top) {
    const s = (circle * weight(f)) / total;
    placeFolder(f, a, s, R0);
    a += s;
  }
  out.radius = Math.max(MIN_RADIUS, far + LABEL_MARGIN);
  return out;
}

/** World-space centre of each vault: circles packed in rows, in the given order. */
export function layoutWorld(layouts: VaultLayout[], gap = 48): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  if (!layouts.length) return out;
  const cell = (l: VaultLayout) => 2 * l.radius + gap;
  const cells = layouts.map(cell);
  const width = Math.max(Math.max(...cells), Math.sqrt(cells.reduce((s, c) => s + c * c, 0)));
  const rows: VaultLayout[][] = [];
  let row: VaultLayout[] = [];
  let used = 0;
  layouts.forEach((l, i) => {
    if (row.length && used + cells[i] > width + 1e-6) {
      rows.push(row);
      row = [];
      used = 0;
    }
    row.push(l);
    used += cells[i];
  });
  rows.push(row);
  let y = 0;
  for (const r of rows) {
    const h = Math.max(...r.map(cell));
    let x = 0;
    for (const l of r) {
      out[l.vaultId] = { x: x + gap / 2 + l.radius, y: y + h / 2 };
      x += cell(l);
    }
    y += h;
  }
  return out;
}
