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
/** Between note rows; not less than MIN_GAP. */
export const NSTEP = 14;
/** Minimum chord between neighbouring dots in one row. */
export const MIN_GAP = 12;
/** Room past the farthest dot for its label. */
export const LABEL_MARGIN = 28;
/** Most a row's angular spacing may be, in multiples of the MIN_GAP step, so notes cluster at their folder. */
export const NOTE_SPREAD = 1.6;
/** Angle left free at the top of the circle, where the hub name sits. */
export const HUB_GAP = Math.PI / 3;
const MIN_RADIUS = 60;
const START = -Math.PI / 2 + HUB_GAP / 2;

/** Angle between neighbours a chord of MIN_GAP apart at radius `r`. */
const minStep = (r: number) => 2 * Math.asin(Math.min(1, MIN_GAP / (2 * r)));

const polar = (r: number, a: number): Pt => ({ x: r * Math.cos(a), y: r * Math.sin(a) });
const tie = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byName = (a: GraphFolder, b: GraphFolder) => a.name.localeCompare(b.name) || tie(a, b);
const byTitle = (a: GraphNote, b: GraphNote) => a.title.localeCompare(b.title) || tie(a, b);

/** Rows for `count` notes spread across an angular `span`, the first at hub radius `r0`. */
export function noteRows(count: number, span: number, r0: number): { r: number; n: number }[] {
  const rows: { r: number; n: number }[] = [];
  for (let left = count, k = 0; left > 0; k++) {
    const r = r0 + k * NSTEP;
    const n = Math.min(left, Math.max(1, Math.floor(span / minStep(r) + 1e-9)));
    rows.push({ r, n });
    left -= n;
  }
  return rows;
}

export function layoutVault(graph: VaultGraph): VaultLayout {
  const kids = new Map<string | null, GraphFolder[]>();
  for (const f of graph.folders) kids.set(f.parentId, [...(kids.get(f.parentId) ?? []), f]);
  for (const list of kids.values()) list.sort(byName);
  const notesIn = new Map<string | null, GraphNote[]>();
  for (const n of graph.notes) notesIn.set(n.folderId, [...(notesIn.get(n.folderId) ?? []), n]);
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

  const placeNotes = (list: GraphNote[], parent: string | null, a0: number, span: number, r0: number): number => {
    let i = 0;
    let outer = 0;
    const centre = a0 + span / 2;
    for (const row of noteRows(list.length, span, r0)) {
      // Clustered around the slice centre; never wider than the slice.
      const spacing = Math.min(span / row.n, NOTE_SPREAD * minStep(row.r));
      for (let j = 0; j < row.n; j++, i++) {
        out.notes[list[i].id] = polar(row.r, centre + (j - (row.n - 1) / 2) * spacing);
        out.parent[list[i].id] = parent;
      }
      outer = row.r;
    }
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
