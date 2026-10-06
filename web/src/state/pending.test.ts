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
    expect(await sendPending(item(), io)).toBe('saved');
    expect(io.createNote).not.toHaveBeenCalled();
  });
  it('turns a conflict into a copy note instead of losing text', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toBe('copied');
    expect(io.createNote).toHaveBeenCalledWith('v1', item().copy);
  });
  it('copies when the note was deleted elsewhere', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')), createNote: vi.fn().mockResolvedValue({}) };
    expect(await sendPending(item(), io)).toBe('copied');
  });
  it('keeps the item on network errors', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(0, 'network')), createNote: vi.fn() };
    expect(await sendPending(item(), io)).toBe('retry');
  });
  it('treats an already-created copy as done', async () => {
    const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(new ApiError(409, 'exists')) };
    expect(await sendPending(item(), io)).toBe('copied');
  });

  const inFolder = (): PendingSave => ({ ...item(), copy: { ...item().copy, folderId: 'f1' } });

  it('puts the copy at the vault root when its folder was deleted elsewhere', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockRejectedValueOnce(new ApiError(400, 'invalid_folder')).mockResolvedValue({}),
    };
    expect(await sendPending(inFolder(), io)).toBe('copied');
    expect(io.createNote).toHaveBeenLastCalledWith('v1', { ...inFolder().copy, folderId: null });
  });

  it('drops the item when its vault was deleted elsewhere', async () => {
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
      createNote: vi.fn().mockRejectedValue(new ApiError(404, 'not_found')),
    };
    expect(await sendPending(inFolder(), io)).toBe('dropped');
    expect(io.createNote).toHaveBeenCalledTimes(2);
    expect(io.createNote).toHaveBeenLastCalledWith('v1', { ...inFolder().copy, folderId: null });
  });

  it('drops the item on other client errors instead of retrying forever', async () => {
    for (const err of [new ApiError(400, 'invalid_request'), new ApiError(413, 'too_large'), new ApiError(403, 'forbidden')]) {
      const io = { updateNote: vi.fn().mockRejectedValue(err), createNote: vi.fn() };
      expect(await sendPending(item(), io)).toBe('dropped');
      expect(io.createNote).not.toHaveBeenCalled();
    }
    const io = {
      updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')),
      createNote: vi.fn().mockRejectedValue(new ApiError(400, 'invalid_request')),
    };
    expect(await sendPending(item(), io)).toBe('dropped');
  });

  it('keeps retrying on 401, 5xx and rate limits, also for the copy', async () => {
    for (const err of [new ApiError(401, 'unauthorized'), new ApiError(503, 'unavailable'), new ApiError(429, 'rate_limited')]) {
      const io = { updateNote: vi.fn().mockRejectedValue(new ApiError(409, 'conflict')), createNote: vi.fn().mockRejectedValue(err) };
      expect(await sendPending(item(), io)).toBe('retry');
      expect(await sendPending(item(), { ...io, updateNote: vi.fn().mockRejectedValue(err) })).toBe('retry');
    }
  });
});
