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

export type PendingOutcome = 'saved' | 'copied' | 'retry';

const transient = (e: unknown) => !(e instanceof ApiError) || e.status === 0 || e.status === 401 || e.status >= 500;

/**
 * Sends one queued save. A conflict (409) or a note deleted elsewhere (404) becomes a copy note,
 * so the text is never lost; network, 5xx and 401 errors leave the item for a later retry.
 */
export async function sendPending(
  p: PendingSave,
  io: {
    updateNote: (id: string, b: { encBody: string; baseUpdatedAt?: string }) => Promise<unknown>;
    createNote: (vaultId: string, b: PendingSave['copy']) => Promise<unknown>;
  },
): Promise<PendingOutcome> {
  try {
    await io.updateNote(p.noteId, { encBody: p.encBody, baseUpdatedAt: p.baseUpdatedAt });
    return 'saved';
  } catch (e) {
    if (transient(e)) return 'retry';
    if (!(e instanceof ApiError) || (e.status !== 409 && e.status !== 404)) return 'retry';
  }
  try {
    await io.createNote(p.vaultId, p.copy);
    return 'copied';
  } catch (e) {
    // 409 `exists`: an earlier attempt already created the copy.
    if (e instanceof ApiError && e.status === 409) return 'copied';
    return 'retry';
  }
}
