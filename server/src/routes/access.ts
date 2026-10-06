// Ownership-checked lookups and API serializers for vaults, folders and notes.
// Every lookup throws 404 when the row does not exist or belongs to another user.

import type { Db, FolderRow, NoteRow, VaultRow } from '../db.js';
import { notFound } from '../errors.js';

export interface VaultWithCounts extends VaultRow {
  note_count: number;
  active_note_count: number;
}

const ACTIVE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

const VAULT_SELECT = `
  SELECT v.*,
    (SELECT COUNT(*) FROM notes n WHERE n.vault_id = v.id) AS note_count,
    (SELECT COUNT(*) FROM notes n WHERE n.vault_id = v.id AND n.updated_at >= ?) AS active_note_count
  FROM vaults v`;

const activeSince = () => new Date(Date.now() - ACTIVE_WINDOW_MS).toISOString();

export function listVaults(db: Db, userId: string): VaultWithCounts[] {
  return db
    .prepare(`${VAULT_SELECT} WHERE v.user_id = ? ORDER BY v.created_at, v.id`)
    .all(activeSince(), userId) as unknown as VaultWithCounts[];
}

export function ownedVaultWithCounts(db: Db, userId: string, vaultId: string): VaultWithCounts {
  const row = db
    .prepare(`${VAULT_SELECT} WHERE v.id = ? AND v.user_id = ?`)
    .get(activeSince(), vaultId, userId) as VaultWithCounts | undefined;
  if (!row) throw notFound();
  return row;
}

export function ownedVault(db: Db, userId: string, vaultId: string): VaultRow {
  const row = db.prepare('SELECT * FROM vaults WHERE id = ? AND user_id = ?').get(vaultId, userId) as
    | VaultRow
    | undefined;
  if (!row) throw notFound();
  return row;
}

export function ownedFolder(db: Db, userId: string, folderId: string): FolderRow {
  const row = db
    .prepare('SELECT f.* FROM folders f JOIN vaults v ON v.id = f.vault_id WHERE f.id = ? AND v.user_id = ?')
    .get(folderId, userId) as FolderRow | undefined;
  if (!row) throw notFound();
  return row;
}

export function ownedNote(db: Db, userId: string, noteId: string): NoteRow {
  const row = db
    .prepare('SELECT n.* FROM notes n JOIN vaults v ON v.id = n.vault_id WHERE n.id = ? AND v.user_id = ?')
    .get(noteId, userId) as NoteRow | undefined;
  if (!row) throw notFound();
  return row;
}

/** True when folderId is a folder inside vaultId. */
export function folderInVault(db: Db, vaultId: string, folderId: string): boolean {
  return db.prepare('SELECT 1 FROM folders WHERE id = ? AND vault_id = ?').get(folderId, vaultId) !== undefined;
}

export const vaultJson = (v: VaultWithCounts) => ({
  id: v.id,
  encMeta: v.enc_meta,
  wrappedKey: v.wrapped_key,
  createdAt: v.created_at,
  updatedAt: v.updated_at,
  noteCount: v.note_count,
  activeNoteCount7d: v.active_note_count,
});

export const folderJson = (f: FolderRow) => ({
  id: f.id,
  parentId: f.parent_id,
  encMeta: f.enc_meta,
  createdAt: f.created_at,
  updatedAt: f.updated_at,
});

export const noteHeadJson = (n: Omit<NoteRow, 'enc_body'>) => ({
  id: n.id,
  folderId: n.folder_id,
  encMeta: n.enc_meta,
  size: n.size,
  createdAt: n.created_at,
  updatedAt: n.updated_at,
});
