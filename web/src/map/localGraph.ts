import type { GraphFolder, GraphNote, VaultGraph } from './graph';

export const LOCAL_CAP = 12;

export interface LocalGraph {
  center: GraphNote;
  parent: { kind: 'folder'; folder: GraphFolder } | { kind: 'hub' };
  siblings: GraphNote[];
  siblingsMore: number;
  outgoing: GraphNote[];
  outgoingMore: number;
  incoming: GraphNote[];
  incomingMore: number;
}

const recent = (a: GraphNote, b: GraphNote) => b.updatedAt.localeCompare(a.updatedAt) || a.title.localeCompare(b.title);

function capped(list: GraphNote[]): [GraphNote[], number] {
  const sorted = [...list].sort(recent);
  return [sorted.slice(0, LOCAL_CAP), Math.max(0, sorted.length - LOCAL_CAP)];
}

/** One hop around a note: its folder, folder siblings, and notes it links to or from. */
export function localGraph(graph: VaultGraph, noteId: string): LocalGraph | null {
  const byId = new Map(graph.notes.map((n) => [n.id, n]));
  const center = byId.get(noteId);
  if (!center) return null;
  const folder = center.folderId ? graph.folders.find((f) => f.id === center.folderId) : undefined;

  const outIds = new Set<string>();
  const inIds = new Set<string>();
  for (const l of graph.links) {
    if (l.from === noteId) outIds.add(l.to);
    else if (l.to === noteId) inIds.add(l.from);
  }
  for (const id of outIds) inIds.delete(id);
  const pick = (ids: Set<string>) => [...ids].map((id) => byId.get(id)).filter((n): n is GraphNote => !!n);

  const [outgoing, outgoingMore] = capped(pick(outIds));
  const [incoming, incomingMore] = capped(pick(inIds));
  const [siblings, siblingsMore] = capped(
    graph.notes.filter((n) => n.id !== noteId && n.folderId === center.folderId && !outIds.has(n.id) && !inIds.has(n.id)),
  );
  return {
    center,
    parent: folder ? { kind: 'folder', folder } : { kind: 'hub' },
    siblings,
    siblingsMore,
    outgoing,
    outgoingMore,
    incoming,
    incomingMore,
  };
}
