export const INDEX_TITLE = 'Index';

/** The fields the Index rule reads. Web's NoteView and the MCP's NoteNode both satisfy it. */
export interface IndexCandidate {
  id: string;
  folderId: string | null;
  title: string;
  createdAt: string;
  broken?: boolean;
}

export interface IndexTree<N extends IndexCandidate = IndexCandidate> {
  notes: Record<string, N>;
}

export function indexBody(folderName: string): string {
  return `# ${folderName}\n\nDescribe what lives in this folder.\n`;
}

/** The folder's Index note (`null` folderId = vault root): oldest exact-title match, id as tie-break. */
export function indexNoteOf<N extends IndexCandidate>(tree: IndexTree<N>, folderId: string | null): N | null {
  let best: N | null = null;
  for (const n of Object.values(tree.notes)) {
    if (n.broken || n.folderId !== folderId || n.title !== INDEX_TITLE) continue;
    if (!best || n.createdAt < best.createdAt || (n.createdAt === best.createdAt && n.id < best.id)) best = n;
  }
  return best;
}

export function isIndexNote<N extends IndexCandidate>(tree: IndexTree<N>, note: N): boolean {
  return indexNoteOf(tree, note.folderId)?.id === note.id;
}
