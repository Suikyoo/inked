// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client';
import { LockedError, NoteTooLargeError, type NoteView } from '../state/store';
import { FINAL_WAIT_MS, leaveNote, LEAVE_WAIT_MS, newSaveState, settle, type SaveState, type SettleStore } from './useNoteEditor';

const head = (updatedAt: string) => ({ updatedAt }) as NoteView;

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeStore() {
  return {
    saveNoteBody: vi.fn<SettleStore['saveNoteBody']>(),
    stashUnsaved: vi.fn<SettleStore['stashUnsaved']>().mockResolvedValue(undefined),
    trackSettle: vi.fn<SettleStore['trackSettle']>((p) => p),
  };
}

/** An open note with `saved` on the server (at `t1`) and `typed` in the editor. */
function editing(saved: string, typed: string): SaveState {
  const s = newSaveState('v1', 'n1');
  s.savedBody = saved;
  s.body = typed;
  s.base = 't1';
  return s;
}

/** Puts a save on the wire the way the autosave does. */
function inFlight(s: SaveState, text: string) {
  const d = deferred<NoteView>();
  s.flight = { body: text, save: d.promise };
  s.inFlight = d.promise
    .then((h) => {
      s.base = h.updatedAt;
      s.savedBody = text;
    }, () => undefined)
    .finally(() => {
      s.inFlight = null;
      s.flight = null;
    });
  return d;
}

describe('settle (I4)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('saves normally and queues nothing', async () => {
    const store = fakeStore();
    store.saveNoteBody.mockResolvedValue(head('t2'));
    const s = editing('a', 'ab');
    await settle(store, s, true);
    expect(store.saveNoteBody).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1');
    expect(store.stashUnsaved).not.toHaveBeenCalled();
    expect(s.savedBody).toBe('ab');
    expect(s.base).toBe('t2');
  });

  it('queues the text when the save fails', async () => {
    const store = fakeStore();
    store.saveNoteBody.mockRejectedValue(new ApiError(0, 'network'));
    const s = editing('a', 'ab');
    await settle(store, s, false);
    expect(store.stashUnsaved).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1', { racing: undefined, until: expect.any(Promise) });
    expect(s.savedBody).toBe('ab');
  });

  it('queues a conflicted note without another save, so the queue makes the copy', async () => {
    const store = fakeStore();
    const s = editing('a', 'ab');
    s.conflict = true;
    await settle(store, s, false);
    expect(store.saveNoteBody).not.toHaveBeenCalled();
    expect(store.stashUnsaved).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1', expect.anything());
  });

  it('on lock, hands a save that takes too long to the queue, linked to that save', async () => {
    const store = fakeStore();
    const slow = deferred<NoteView>();
    store.saveNoteBody.mockReturnValue(slow.promise);
    const s = editing('a', 'ab');
    const done = settle(store, s, true);
    await vi.advanceTimersByTimeAsync(FINAL_WAIT_MS);
    await done;
    expect(store.stashUnsaved).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1', {
      racing: { save: slow.promise, sameText: true },
      until: expect.any(Promise),
    });
  });

  it('waits for a save already on the wire instead of racing it', async () => {
    const store = fakeStore();
    store.saveNoteBody.mockResolvedValue(head('t3'));
    const s = editing('a', 'abc');
    const wire = inFlight(s, 'ab');
    const done = settle(store, s, false);
    await vi.advanceTimersByTimeAsync(LEAVE_WAIT_MS - 1);
    expect(store.saveNoteBody).not.toHaveBeenCalled();
    wire.resolve(head('t2'));
    await done;
    expect(store.saveNoteBody).toHaveBeenCalledWith('v1', 'n1', 'abc', 't2');
    expect(store.stashUnsaved).not.toHaveBeenCalled();
  });

  it('a lock during a note-switch flush bounds the wait and queues the rest', async () => {
    const store = fakeStore();
    const s = editing('a', 'abc');
    const wire = inFlight(s, 'ab');
    const switching = settle(store, s, false);
    const locking = settle(store, s, true);
    expect(locking).toBe(switching);
    await vi.advanceTimersByTimeAsync(FINAL_WAIT_MS);
    await locking;
    expect(store.saveNoteBody).not.toHaveBeenCalled();
    expect(store.stashUnsaved).toHaveBeenCalledWith('v1', 'n1', 'abc', 't1', {
      racing: { save: wire.promise, sameText: false },
      until: expect.any(Promise),
    });
  });

  it('leaving a note queues a save that never answers, after a bounded wait', async () => {
    const store = fakeStore();
    const hung = deferred<NoteView>();
    store.saveNoteBody.mockReturnValue(hung.promise);
    const s = editing('a', 'ab');
    const done = settle(store, s, false);
    expect(store.trackSettle).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(LEAVE_WAIT_MS - 1);
    expect(store.stashUnsaved).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await done;
    expect(store.stashUnsaved).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1', {
      racing: { save: hung.promise, sameText: true },
      until: expect.any(Promise),
    });
  });

  it('does nothing more once the keys are gone or the note is too large', async () => {
    for (const err of [new LockedError(), new NoteTooLargeError()]) {
      const store = fakeStore();
      store.saveNoteBody.mockRejectedValue(err);
      await settle(store, editing('a', 'ab'), true);
      expect(store.stashUnsaved).not.toHaveBeenCalled();
    }
  });

  it('skips the flush after "Reload theirs"', async () => {
    const store = fakeStore();
    const s = editing('a', 'ab');
    s.conflict = true;
    s.discard = true;
    await settle(store, s, false);
    expect(store.saveNoteBody).not.toHaveBeenCalled();
    expect(store.stashUnsaved).not.toHaveBeenCalled();
  });
});

describe('leaving a note (unmount, C1/B6)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('settles through trackSettle and unregisters the flusher only after it settles', async () => {
    const store = fakeStore();
    const slow = deferred<NoteView>();
    store.saveNoteBody.mockReturnValue(slow.promise);
    const unregister = vi.fn();
    const s = editing('a', 'ab');
    const left = leaveNote(store, s, unregister);
    expect(store.trackSettle).toHaveBeenCalledTimes(1);
    expect(store.saveNoteBody).toHaveBeenCalledWith('v1', 'n1', 'ab', 't1');
    await vi.advanceTimersByTimeAsync(0);
    expect(unregister).not.toHaveBeenCalled();
    slow.resolve(head('t2'));
    await left;
    expect(unregister).toHaveBeenCalledTimes(1);
  });

  it('a failing settle still unregisters and never rejects', async () => {
    const store = fakeStore();
    store.trackSettle.mockImplementation((p) => p.then(() => Promise.reject(new Error('boom'))));
    store.saveNoteBody.mockResolvedValue(head('t2'));
    const unregister = vi.fn();
    await expect(leaveNote(store, editing('a', 'ab'), unregister)).resolves.toBeUndefined();
    expect(unregister).toHaveBeenCalledTimes(1);
  });
});
