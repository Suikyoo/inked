import { indexNoteOf, INDEX_TITLE } from '../lib/indexNote';
import { titleIndex } from '../lib/titles';
import { wikiLinkTargets } from '../markdown/plugins';
import type { TreeView } from '../state/store';

export interface GraphFolder {
  id: string;
  parentId: string | null;
  name: string;
  depth: number;
}
export interface GraphNote {
  id: string;
  folderId: string | null;
  title: string;
  updatedAt: string;
  /** The Index note of its folder (or of the vault root): it has no dot, its folder stands for it. */
  index: boolean;
}
export interface GraphLink {
  from: string;
  to: string;
}
export interface VaultGraph {
  vaultId: string;
  folders: GraphFolder[];
  notes: GraphNote[];
  links: GraphLink[];
  /** Mirrors bodiesReady: until then links may be missing. */
  linksReady: boolean;
}

// `](/v/<vault>/n/<note>` followed by `#`, `?`, `)`, whitespace, `>` or `"`.
const NOTE_LINK_RE = /\]\(\s*<?\/v\/([^/\s#?)>"]+)\/n\/([^/\s#?)>"]+)(?=[#?)\s>"])/g;

/** Note ids a Markdown body links to: [[wiki-links]] by title, and root-relative links in this vault. */
export function noteLinkTargets(src: string, vaultId: string, titles: Map<string, string>): Set<string> {
  const out = new Set<string>();
  for (const t of wikiLinkTargets(src)) {
    const id = titles.get(t);
    if (id) out.add(id);
  }
  for (const m of src.matchAll(NOTE_LINK_RE)) {
    if (m[1] === vaultId) out.add(m[2]);
  }
  return out;
}

const byId = (a: { id: string }, b: { id: string }) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const byLink = (a: GraphLink, b: GraphLink) =>
  a.from < b.from ? -1 : a.from > b.from ? 1 : a.to < b.to ? -1 : a.to > b.to ? 1 : 0;

export function buildVaultGraph(
  vaultId: string,
  tree: TreeView,
  bodies: Record<string, string>,
  bodiesReady: boolean,
): VaultGraph {
  const live = new Map(Object.values(tree.folders).filter((f) => !f.broken).map((f) => [f.id, f]));

  // A missing or broken parent makes the folder top-level.
  const parentOf = new Map<string, string | null>();
  for (const f of live.values()) parentOf.set(f.id, f.parentId && live.has(f.parentId) ? f.parentId : null);
  // Corrupt data could hold a cycle: cut it where it is first seen.
  for (const f of live.values()) {
    const seen = new Set([f.id]);
    for (let p = parentOf.get(f.id) ?? null; p; p = parentOf.get(p) ?? null) {
      if (seen.has(p)) {
        parentOf.set(f.id, null);
        break;
      }
      seen.add(p);
    }
  }
  const depthOf = (id: string) => {
    let d = 0;
    for (let p = parentOf.get(id) ?? null; p; p = parentOf.get(p) ?? null) d++;
    return d;
  };

  const folders: GraphFolder[] = [...live.values()]
    .map((f) => ({ id: f.id, parentId: parentOf.get(f.id) ?? null, name: f.name, depth: depthOf(f.id) }))
    .sort(byId);

  const liveNotes = Object.values(tree.notes).filter((n) => !n.broken);
  const indexIds = new Set<string>();
  for (const folderId of new Set(liveNotes.filter((n) => n.title === INDEX_TITLE).map((n) => n.folderId))) {
    const ix = indexNoteOf(tree, folderId);
    if (ix) indexIds.add(ix.id);
  }
  const notes: GraphNote[] = liveNotes
    .map((n) => {
      const folderId = n.folderId && live.has(n.folderId) ? n.folderId : null;
      // An Index left in a broken folder sits at the root, where it is not the root's Index.
      return { id: n.id, folderId, title: n.title, updatedAt: n.updatedAt, index: indexIds.has(n.id) && folderId === n.folderId };
    })
    .sort(byId);

  const ids = new Set(notes.map((n) => n.id));
  const titles = titleIndex({ ...tree, notes: Object.fromEntries(liveNotes.map((n) => [n.id, n])) });
  const links: GraphLink[] = [];
  for (const n of notes) {
    const body = bodies[n.id];
    if (!body) continue;
    for (const to of noteLinkTargets(body, vaultId, titles)) {
      if (to !== n.id && ids.has(to)) links.push({ from: n.id, to });
    }
  }
  links.sort(byLink);

  return { vaultId, folders, notes, links, linksReady: bodiesReady };
}

/** Changes only when something the layout depends on changes (not edit times or links). */
export function structureKey(g: VaultGraph): string {
  return JSON.stringify([g.folders.map((f) => [f.id, f.parentId, f.name]), g.notes.map((n) => [n.id, n.folderId, n.title])]);
}

/** Notes that link to `noteId` (backlinks), sorted by title. */
export function incomingLinks(g: VaultGraph, noteId: string): GraphNote[] {
  const from = new Set(g.links.filter((l) => l.to === noteId).map((l) => l.from));
  return g.notes.filter((n) => from.has(n.id)).sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
}
