import type { NoteView, TreeView } from '../state/store';

export const INDEX_TITLE = 'Index';

export function indexBody(folderName: string): string {
  return `# ${folderName}\n\nDescribe what lives in this folder.\n`;
}

/** The folder's Index note (`null` folderId = vault root): oldest exact-title match, id as tie-break. */
export function indexNoteOf(tree: TreeView, folderId: string | null): NoteView | null {
  let best: NoteView | null = null;
  for (const n of Object.values(tree.notes)) {
    if (n.broken || n.folderId !== folderId || n.title !== INDEX_TITLE) continue;
    if (!best || n.createdAt < best.createdAt || (n.createdAt === best.createdAt && n.id < best.id)) best = n;
  }
  return best;
}

export function isIndexNote(tree: TreeView, note: NoteView): boolean {
  return indexNoteOf(tree, note.folderId)?.id === note.id;
}
