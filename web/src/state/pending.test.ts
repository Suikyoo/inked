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
