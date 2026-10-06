import { ApiError } from '../api/client';

/** A note body that could not be saved yet. Ciphertext only, so it can wait out a lock. */
export interface PendingSave {
  noteId: string;
  vaultId: string;
  encBody: string; // ciphertext for this note's own slot
  baseUpdatedAt?: string;
  copy: { id: string; folderId: string | null; encMeta: string; encBody: string }; // pre-encrypted "(unsaved copy)" note
  attempts: number;
}

/** `dropped`: the server can never take it (vault deleted elsewhere, other client errors). */
export type PendingOutcome = 'saved' | 'copied' | 'retry' | 'dropped';

/** Worth trying again later: offline, signed out, server trouble, rate limits. */
const transient = (e: unknown) =>
  !(e instanceof ApiError) || e.status === 0 || e.status === 401 || e.status === 408 || e.status === 429 || e.status >= 500;

type PendingIO = {
  updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => Promise<unknown>;
  createNote: (vaultId: string, b: PendingSave['copy']) => Promise<unknown>;
};

/**
 * Sends one queued save. A conflict (409) or a note deleted elsewhere (404) becomes a copy note,
 * so the text is never lost; network, 5xx and 401 errors leave the item for a later retry.
 * Other client errors can never succeed, so the item is dropped (and the user told).
 */
export async function sendPending(p: PendingSave, io: PendingIO): Promise<PendingOutcome> {
  try {
    await io.updateNote(p.noteId, { encBody: p.encBody, baseUpdatedAt: p.baseUpdatedAt });
    return 'saved';
  } catch (e) {
    if (transient(e)) return 'retry';
    if (!(e instanceof ApiError) || (e.status !== 409 && e.status !== 404)) return 'dropped';
  }
  const outcome = await createCopy(p.vaultId, p.copy, io);
  // The note's folder was deleted elsewhere (with the note): put the copy at the vault root.
  // The folder is not part of the AAD, so the ciphertext stays valid without any key.
  if (outcome !== 'folderGone') return outcome;
  const atRoot = await createCopy(p.vaultId, { ...p.copy, folderId: null }, io);
  return atRoot === 'folderGone' ? 'dropped' : atRoot;
}

async function createCopy(
  vaultId: string,
  copy: PendingSave['copy'],
  io: PendingIO,
): Promise<PendingOutcome | 'folderGone'> {
  try {
    await io.createNote(vaultId, copy);
    return 'copied';
  } catch (e) {
    if (transient(e) || !(e instanceof ApiError)) return 'retry';
    // 409 `exists`: an earlier attempt already created the copy.
    if (e.status === 409) return 'copied';
    if (copy.folderId !== null && ((e.status === 400 && e.code === 'invalid_folder') || e.status === 404)) return 'folderGone';
    // 404 at the root: the vault itself is gone. Anything else: the server will never take it.
    return 'dropped';
  }
}
