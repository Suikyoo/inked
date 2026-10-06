import type { FolderView, NoteView, TreeView, VaultView } from '../state/store';

/** Shared test builders for the map modules. Not imported by app code. */
export const T0 = '2026-10-01T00:00:00.000Z';

export function folder(id: string, parentId: string | null, name = id, extra: Partial<FolderView> = {}): FolderView {
  return { id, vaultId: 'v1', parentId, name, createdAt: T0, updatedAt: T0, ...extra };
}

export function note(id: string, folderId: string | null, title = id, extra: Partial<NoteView> = {}): NoteView {
  return { id, vaultId: 'v1', folderId, title, size: 0, createdAt: T0, updatedAt: T0, ...extra };
}

export function tree(folders: FolderView[], notes: NoteView[], status: TreeView['status'] = 'ready'): TreeView {
  return {
    status,
    folders: Object.fromEntries(folders.map((f) => [f.id, f])),
    notes: Object.fromEntries(notes.map((n) => [n.id, n])),
  };
}

export function vault(id: string, name = `Vault ${id}`): VaultView {
  return { id, name, color: '#9d7cf2', createdAt: T0, updatedAt: T0, noteCount: 0, activeNoteCount7d: 0 };
}
