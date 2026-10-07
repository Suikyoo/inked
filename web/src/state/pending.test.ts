import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { sendPending, type PendingSave } from './pending';

const item = (): PendingSave => ({
  noteId: 'n1', vaultId: 'v1', encBody: 'v1.body', baseUpdatedAt: 't1',
  copy: { id: 'c1', folderId: null, encMeta: 'v1.meta', encBody: 'v1.copybody' }, attempts: 0,
});

describe('sendPending', () => {
  it('saves normally', async () => {
    const io = { updateNote: vi.fn().mockResolvedValue({}), createNote: vi.fn() };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'saved' });
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('turns a conflict into a copy note instead of losing text', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
    expect(io.createNote).toHaveBeenCalledWith('v1', item().copy);
  });
  it('copies when the note was deleted elsewhere', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
  });
  it('keeps the item on network errors', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(0, 'network')), createNote: vi.fn() };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'retry' });
  });
  it('treats an already-created copy as done', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(new ApiError(409, 'exists')) };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
  });
  it('retries a copy refused with any other 409 (B2)', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')) };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'retry' });
  });

  it('counts a 409 as saved when the server already holds exactly the queued ciphertext (D4a)', async () => {
    // An earlier attempt timed out after the server applied it: the retry's base is now stale.
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn(),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.body' } }),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'saved' });
    expect(io.getNote).toHaveBeenCalledWith('n1');
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('still copies on a 409 when the server holds a different body (D4a)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn().mockResolvedValue({}),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.other' } }),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
    expect(io.createNote).toHaveBeenCalledWith('v1', item().copy);
  });
  it('retries a 409 when the check of the stored body hits a network error (D4a)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn(),
      getNote: vi.fn().mockRejectedValue(new ApiError(0, 'network')),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'retry' });
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('copies on a 409 when the note is gone by the time its body is checked (D4a)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn().mockResolvedValue({}),
      getNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
  });
  it('counts a 409 as saved when the stored body is other ciphertext of the same text (D4a)', async () => {
    // A racing save landed with its own IV; the queued item was encrypted separately.
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn(),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.same-text-other-iv' } }),
      sameText: vi.fn().mockResolvedValue(true),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'saved' });
    expect(io.sameText).toHaveBeenCalledWith(item(), 'v1.same-text-other-iv');
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('copies on a 409 when the stored text differs (D4a)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn().mockResolvedValue({}),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.other' } }),
      sameText: vi.fn().mockResolvedValue(false),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
  });
  it('falls back to ciphertext equality when the text cannot be compared (locked, or a decrypt failure) (D4a)', async () => {
    const failing = () => vi.fn().mockRejectedValue(new Error('decrypt'));
    const equal = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn(),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.body' } }),
      sameText: failing(),
    };
    expect(await sendPending(item(), equal)).toEqual({ outcome: 'saved' });
    expect(equal.sameText).not.toHaveBeenCalled(); // equal ciphertext needs no key
    const other = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn().mockResolvedValue({}),
      getNote: vi.fn().mockResolvedValue({ note: { encBody: 'v1.other' } }),
      sameText: failing(),
    };
    expect(await sendPending(item(), other)).toEqual({ outcome: 'copied' });
  });
  it('never checks the stored body on a 404 (D4a)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockResolvedValue({}),
      getNote: vi.fn(),
    };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'copied' });
    expect(io.getNote).not.toHaveBeenCalled();
  });

  const inFolder = (): PendingSave => ({ ...item(), copy: { ...item().copy, folderId: 'f1' } });

  it('puts the copy at the vault root when its folder was deleted elsewhere, and says so (B1)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockRejectedValueOnce(new ApiError(400, 'invalid_folder')).mockResolvedValue({}),
    };
    expect(await sendPending(inFolder(), io)).toEqual({ outcome: 'copiedToRoot' });
    expect(io.createNote).toHaveBeenLastCalledWith('v1', { ...inFolder().copy, folderId: null });
  });

  it('drops the item as deleted when its vault was deleted elsewhere (B1)', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
    };
    expect(await sendPending(inFolder(), io)).toEqual({ outcome: 'dropped', reason: 'deleted' });
    expect(io.createNote).toHaveBeenCalledTimes(2);
    expect(io.createNote).toHaveBeenLastCalledWith('v1', { ...inFolder().copy, folderId: null });
    // At the root straight away.
    const root = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
    };
    expect(await sendPending(item(), root)).toEqual({ outcome: 'dropped', reason: 'deleted' });
    expect(root.createNote).toHaveBeenCalledTimes(1);
  });

  it('drops the item on other client errors, naming the cause (B1)', async () => {
    const cases: [ApiError, string][] = [
      [new ApiError(400, 'invalid_request'), 'rejected'],
      [new ApiError(403, 'forbidden'), 'rejected'],
      [new ApiError(413, 'too_large'), 'too_large'],
    ];
    for (const [err, reason] of cases) {
      const io = { updateNote: vi.fn().mockRejectedValue(err), createNote: vi.fn() };
      expect(await sendPending(item(), io)).toEqual({ outcome: 'dropped', reason });
      expect(io.createNote).not.toHaveBeenCalled();
    }
    for (const [err, reason] of cases) {
      const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(err) };
      expect(await sendPending(item(), io)).toEqual({ outcome: 'dropped', reason });
    }
  });

  it('keeps an item refused as another account’s (409 user_mismatch): never a conflict, never an existing copy', async () => {
    const mismatch = new ApiError(409, 'user_mismatch');
    const io = { updateNote: vi.fn().mockRejectedValue(mismatch), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toEqual({ outcome: 'retry' });
    expect(io.createNote).not.toHaveBeenCalled();
    const copy = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(mismatch) };
    expect(await sendPending(item(), copy)).toEqual({ outcome: 'retry' });
    const root = { updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')), createNote: vi.fn().mockRejectedValue(mismatch) };
    expect(await sendPending({ ...item(), copy: { ...item().copy, folderId: 'f1' } }, root)).toEqual({ outcome: 'retry' });
    expect(root.createNote).toHaveBeenCalledTimes(1);
  });

  it('keeps retrying on 401, 5xx and rate limits, also for the copy', async () => {
    for (const err of [new ApiError(401, 'unauthorized'), new ApiError(503, 'unavailable'), new ApiError(429, 'rate_limited')]) {
      const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(err) };
      expect(await sendPending(item(), io)).toEqual({ outcome: 'retry' });
      expect(await sendPending(item(), { ...io, updateNote: vi.fn().mockRejectedValue(err) })).toEqual({ outcome: 'retry' });
    }
  });
});
