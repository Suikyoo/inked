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
});
