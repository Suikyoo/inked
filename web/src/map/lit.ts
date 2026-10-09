import type { LinkSeg, Scene } from './scene';

export interface FocusInputs {
  hover: string | null;
  keyboard: string | null;
  hot: string | null;
  selectedNote: string | null;
  searching: boolean;
}

/** The one note the map lights. Only note ids go in: callers pass null for a folder or hub. */
export function mapFocus(o: FocusInputs): string | null {
  if (o.searching) return o.selectedNote;
  return o.hover ?? o.keyboard ?? o.hot ?? o.selectedNote;
}

export interface LitSet {
  notes: Set<string>;
  folders: Set<string>;
  /** Link segments touching the focus. */
  links: LinkSeg[];
}

/** The focus, its link neighbours and its meaning neighbours, with the folders on their paths. */
export function litSet(focus: string | null, scene: Scene, meaning: readonly string[]): LitSet {
  const notes = new Set<string>();
  const folders = new Set<string>();
  const links: LinkSeg[] = [];
  if (focus === null) return { notes, folders, links };
  notes.add(focus);
  for (const l of scene.links) {
    if (l.a !== focus && l.b !== focus) continue;
    links.push(l);
    notes.add(l.a === focus ? l.b : l.a);
  }
  for (const id of meaning) notes.add(id);
  for (const id of notes) for (const f of scene.chainFolders[id] ?? []) folders.add(f);
  return { notes, folders, links };
}

/** A folder's whole subtree: every folder and note beneath it, the folder itself and the folders above it. */
export function folderLit(folderId: string, scene: Scene): LitSet {
  const notes = new Set<string>();
  const folders = new Set<string>();
  for (const f of scene.folders) {
    if (f.id === folderId || scene.chainFolders[f.id]?.includes(folderId)) for (const a of scene.chainFolders[f.id]) folders.add(a);
  }
  for (const d of scene.dots) if (d.folderIds.includes(folderId)) notes.add(d.id);
  return { notes, folders, links: [] };
}
