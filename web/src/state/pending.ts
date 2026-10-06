import { ApiError, isUserMismatch } from '../api/client';

/** A note body that could not be saved yet. Ciphertext only, so it can wait out a lock. */
export interface PendingSave {
  noteId: string;
  vaultId: string;
  encBody: string; // ciphertext for this note's own slot
  baseUpdatedAt?: string;
  copy: { id: string; folderId: string | null; encMeta: string; encBody: string }; // pre-encrypted "(unsaved copy)" note
  attempts: number;
}

/**
 * `copied`: saved as a copy note next to the original. `copiedToRoot`: the same, at the vault root,
 * because the note's folder was deleted elsewhere. `dropped`: the server can never take it.
 */
export type PendingOutcome = 'saved' | 'copied' | 'copiedToRoot' | 'dropped' | 'retry';

/** Why a dropped item could never be saved: its note and vault are gone, the server refused it, or it is too big. */
export type DropReason = 'deleted' | 'rejected' | 'too_large';

/** `reason` is set only for `dropped`. */
export interface PendingResult {
  outcome: PendingOutcome;
  reason?: DropReason;
}

/**
 * Worth trying again later: offline, signed out, server trouble, rate limits, or another account's
 * session in this browser (409 user_mismatch: never a conflict, never an existing copy).
 */
const transient = (e: unknown) =>
  !(e instanceof ApiError) ||
  e.status === 0 ||
  e.status === 401 ||
  e.status === 408 ||
  e.status === 429 ||
  e.status >= 500 ||
  isUserMismatch(e);

const dropped = (reason: DropReason): PendingResult => ({ outcome: 'dropped', reason });

/** A client error the server will never accept, by its cause. */
const refused = (e: ApiError): PendingResult => dropped(e.status === 413 ? 'too_large' : 'rejected');

type PendingIO = {
  updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => Promise<unknown>;
  createNote: (vaultId: string, b: PendingSave['copy']) => Promise<unknown>;
};

/**
 * Sends one queued save. A conflict (409) or a note deleted elsewhere (404) becomes a copy note,
 * so the text is never lost; network, 5xx, 401 and user_mismatch errors leave the item for a later retry.
 * Other client errors can never succeed, so the item is dropped (and the user told why).
 */
export async function sendPending(p: PendingSave, io: PendingIO): Promise<PendingResult> {
  try {
    await io.updateNote(p.noteId, { encBody: p.encBody, baseUpdatedAt: p.baseUpdatedAt });
    return { outcome: 'saved' };
  } catch (e) {
    if (transient(e)) return { outcome: 'retry' };
    if (e instanceof ApiError && e.status !== 409 && e.status !== 404) return refused(e);
  }
  const result = await createCopy(p.vaultId, p.copy, io);
  // The note's folder was deleted elsewhere (with the note): put the copy at the vault root.
  // The folder is not part of the AAD, so the ciphertext stays valid without any key.
  if (result !== 'folderGone') return result;
  const atRoot = await createCopy(p.vaultId, { ...p.copy, folderId: null }, io);
  if (atRoot === 'folderGone') return dropped('deleted'); // cannot happen at the root
  return atRoot.outcome === 'copied' ? { outcome: 'copiedToRoot' } : atRoot;
}

async function createCopy(vaultId: string, copy: PendingSave['copy'], io: PendingIO): Promise<PendingResult | 'folderGone'> {
  try {
    await io.createNote(vaultId, copy);
    return { outcome: 'copied' };
  } catch (e) {
    if (transient(e) || !(e instanceof ApiError)) return { outcome: 'retry' };
    if (e.status === 409) {
      // `exists`: an earlier attempt already created the copy. Any other conflict may clear up.
      return e.code === 'exists' ? { outcome: 'copied' } : { outcome: 'retry' };
    }
    if (copy.folderId !== null && ((e.status === 400 && e.code === 'invalid_folder') || e.status === 404)) return 'folderGone';
    // 404 at the root: the vault itself is gone. Anything else: the server will never take it.
    return e.status === 404 ? dropped('deleted') : refused(e);
  }
}
