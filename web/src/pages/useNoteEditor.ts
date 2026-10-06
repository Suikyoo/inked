import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError, isUserMismatch } from '../api/client';
import { describeError } from '../lib/util';
import { LockedError, NoteTooLargeError, type AppStore, type NoteView } from '../state/store';
import { useStore } from '../state/StoreContext';
import { LOCK_WAIT_MS } from '../state/tabs';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

const AUTOSAVE_MS = 800;
/** Once the keys are about to go (lock, sign out), how long a flush waits for the network before queueing. */
export const FINAL_WAIT_MS = LOCK_WAIT_MS;
/** When leaving a note, how long its flush waits for the network before queueing. */
export const LEAVE_WAIT_MS = 10_000;

/** Never resolves until `arm(ms)`; then resolves `ms` later. A later, sooner arm wins. Bounds every wait in `settle`. */
interface Cutoff {
  promise: Promise<void>;
  arm: (ms: number) => void;
}

function cutoff(): Cutoff {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  let deadline = Infinity;
  let timer: number | undefined;
  const arm = (ms: number) => {
    const at = Date.now() + ms;
    if (at >= deadline) return;
    deadline = at;
    window.clearTimeout(timer);
    timer = window.setTimeout(resolve, ms);
  };
  return { promise, arm };
}

/** Mutable save machinery for one open note. */
export interface SaveState {
  vaultId: string;
  noteId: string;
  body: string;
  savedBody: string;
  base: string | undefined;
  timer: number | undefined;
  inFlight: Promise<void> | null;
  /** The save on the wire and the text it carries. */
  flight: { body: string; save: Promise<NoteView> } | null;
  conflict: boolean;
  force: boolean;
  alive: boolean;
  /** "Reload theirs": the local edits are discarded on purpose. */
  discard: boolean;
  settling: Promise<void> | null;
  cutoff: Cutoff;
}

export function newSaveState(vaultId: string, noteId: string): SaveState {
  return {
    vaultId,
    noteId,
    body: '',
    savedBody: '',
    base: undefined,
    timer: undefined,
    inFlight: null,
    flight: null,
    conflict: false,
    force: false,
    alive: true,
    discard: false,
    settling: null,
    cutoff: cutoff(),
  };
}

export type SettleStore = Pick<AppStore, 'saveNoteBody' | 'stashUnsaved' | 'trackSettle'>;

/**
 * Saves the note's edits if possible; anything that can't be saved in time goes to the store's
 * ciphertext queue, so no text is dropped. Every wait is capped: FINAL_WAIT_MS when the keys are
 * about to go (`final`: lock / sign out), LEAVE_WAIT_MS when leaving the note; a final call also
 * shortens a pass already running. Concurrent calls share one pass, which the store counts as
 * unsaved work (close-tab prompt) until it ends.
 */
export function settle(store: SettleStore, s: SaveState, final: boolean): Promise<void> {
  s.cutoff.arm(final ? FINAL_WAIT_MS : LEAVE_WAIT_MS);
  if (!s.settling) {
    s.settling = store.trackSettle(settleOnce(store, s)).finally(() => {
      s.settling = null;
    });
  }
  return s.settling;
}

/**
 * Leaving a note (unmount, note switch): flush it, and stay registered as a flusher until its edits
 * are saved or queued, so a lock in the meantime still waits for them (and caps the wait).
 * Never rejects.
 */
export function leaveNote(store: SettleStore, s: SaveState, unregister: () => void): Promise<void> {
  return settle(store, s, false)
    .catch(() => undefined)
    .finally(unregister);
}

async function settleOnce(store: SettleStore, s: SaveState): Promise<void> {
  window.clearTimeout(s.timer);
  s.timer = undefined;
  if (s.discard) return;
  // A save already on the wire: let it land so its updatedAt becomes the base (never race it).
  if (s.inFlight) await Promise.race([s.inFlight, s.cutoff.promise]);
  if (s.body === s.savedBody) return;
  // Still set only if the wait was cut off.
  let racing = s.flight;
  if (!racing && !s.conflict) {
    const save = track(store, s, s.body, s.base);
    const result = await Promise.race([
      save.then(
        () => 'saved' as const,
        (e: unknown) => e,
      ),
      s.cutoff.promise.then(() => 'late' as const),
    ]);
    if (result === 'late') racing = s.flight;
    // Keys already gone: nothing to encrypt with. Too large: the queue could never send it either.
    else if (result instanceof LockedError || result instanceof NoteTooLargeError) return;
    if (s.body === s.savedBody) return;
  }
  // Conflicts, failed saves and saves still on the wire: the queue owns the text from here.
  const body = s.body;
  const prev = s.savedBody;
  s.savedBody = body;
  try {
    await store.stashUnsaved(s.vaultId, s.noteId, body, s.base, {
      racing: racing ? { save: racing.save, sameText: racing.body === body } : undefined,
      until: s.cutoff.promise,
    });
  } catch {
    // Keys already gone (or too large): nothing more can be done with this text.
    if (s.savedBody === body) s.savedBody = prev;
  }
}

/** Starts a save and records it as the one in flight; on success its text becomes the saved base. */
function track(store: SettleStore, s: SaveState, snapshot: string, base: string | undefined): Promise<NoteView> {
  const save = store.saveNoteBody(s.vaultId, s.noteId, snapshot, base);
  const flight = { body: snapshot, save };
  s.flight = flight;
  s.inFlight = save
    .then(
      (head) => {
        s.base = head.updatedAt;
        s.savedBody = snapshot;
      },
      () => undefined,
    )
    .finally(() => {
      if (s.flight === flight) {
        s.inFlight = null;
        s.flight = null;
      }
    });
  return save;
}

/**
 * Someone saved this note in between. A 409 user_mismatch is not: another tab signed in as someone
 * else, and the store ends this tab's session (flushing this text into the queue).
 */
export const isSaveConflict = (e: unknown): boolean => isApiError(e, 409) && !isUserMismatch(e);

/**
 * A head changed through another path (rename, move): move the conflict base onto it. Only this
 * tab's own writes may move the base; anyone else's change must still raise a conflict.
 */
export function adoptOwnHead(store: Pick<AppStore, 'isOwnStamp'>, s: SaveState, head: NoteView) {
  if (head.id === s.noteId && !s.inFlight && store.isOwnStamp(head.id, head.updatedAt) && (!s.base || head.updatedAt > s.base)) {
    s.base = head.updatedAt;
  }
}

export interface NoteEditor {
  status: 'loading' | 'ready' | 'error';
  loadError: string | null;
  body: string;
  setBody: (b: string) => void;
  save: SaveStatus;
  saveError: string | null;
  reload: () => void;
  overwrite: () => void;
  /** Call when the note head changes through another path (rename, move) to keep the conflict base in sync. */
  adoptHead: (head: NoteView) => void;
}

/**
 * Loads + decrypts one note and autosaves the body 800 ms after typing stops.
 * Saves are serialised, carry `baseUpdatedAt` for conflict detection and are flushed on
 * note switch, unmount and lock.
 */
export function useNoteEditor(vaultId: string, noteId: string): NoteEditor {
  const store = useStore();
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [body, setBodyState] = useState('');
  const [save, setSave] = useState<SaveStatus>('idle');
  const [saveError, setSaveError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  // Mutable save machinery, scoped to the current note.
  const r = useRef(newSaveState(vaultId, noteId));

  const doSave = useCallback(async (): Promise<void> => {
    const s = r.current;
    window.clearTimeout(s.timer);
    s.timer = undefined;
    if (s.inFlight) {
      await s.inFlight;
      return doSave();
    }
    if (s.conflict && !s.force) return;
    if (s.body === s.savedBody) {
      if (s.alive) setSave((cur) => (cur === 'pending' ? 'saved' : cur));
      return;
    }
    const snapshot = s.body;
    const target = { vaultId: s.vaultId, noteId: s.noteId };
    if (s.alive) setSave('saving');
    const save = store.saveNoteBody(target.vaultId, target.noteId, snapshot, s.force ? undefined : s.base);
    s.flight = { body: snapshot, save };
    s.inFlight = (async () => {
      try {
        const head = await save;
        s.base = head.updatedAt;
        s.savedBody = snapshot;
        s.force = false;
        s.conflict = false;
        if (s.alive) {
          setSaveError(null);
          setSave(s.body === snapshot ? 'saved' : 'pending');
        }
      } catch (e) {
        if (isSaveConflict(e)) {
          s.conflict = true;
          if (s.alive) setSave('conflict');
        } else if (!(e instanceof LockedError)) {
          if (s.alive) {
            setSave('error');
            setSaveError(describeError(e));
          }
        }
      } finally {
        s.inFlight = null;
        s.flight = null;
      }
    })();
    await s.inFlight;
    // Typing continued while saving: save again soon.
    if (s.body !== s.savedBody && !s.conflict && s.alive) schedule();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

  const schedule = useCallback(() => {
    const s = r.current;
    window.clearTimeout(s.timer);
    s.timer = window.setTimeout(() => void doSave(), AUTOSAVE_MS);
  }, [doSave]);

  // Load (and reload) the note.
  useEffect(() => {
    const s = newSaveState(vaultId, noteId);
    r.current = s;
    setStatus('loading');
    setLoadError(null);
    setSave('idle');
    setSaveError(null);
    let cancelled = false;
    store.loadNote(vaultId, noteId).then(
      ({ head, body: text }) => {
        if (cancelled) return;
        s.body = text;
        s.savedBody = text;
        s.base = head.updatedAt;
        setBodyState(text);
        setStatus('ready');
      },
      (e) => {
        if (cancelled) return;
        setLoadError(
          isApiError(e, 404) || isApiError(e, 400)
            ? 'This note doesn’t exist any more.'
            : describeError(e, 'This note could not be opened.'),
        );
        setStatus('error');
      },
    );
    const unregister = store.registerFlusher((final) => settle(store, s, final));
    return () => {
      cancelled = true;
      s.alive = false;
      void leaveNote(store, s, unregister);
    };
  }, [vaultId, noteId, reloadTick, store]);

  // Warn before closing the tab with unsaved edits.
  useEffect(() => {
    const onBeforeUnload = (e: BeforeUnloadEvent) => {
      const s = r.current;
      if (s.body !== s.savedBody || s.inFlight) {
        e.preventDefault();
        void doSave();
      }
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [doSave]);

  const setBody = useCallback(
    (b: string) => {
      // A lock is stashing this text: later changes could not be saved, so refuse them (the textarea is read-only).
      if (store.getState().locking) return;
      const s = r.current;
      s.body = b;
      setBodyState(b);
      if (s.conflict) return;
      setSave('pending');
      schedule();
    },
    [schedule, store],
  );

  const reload = useCallback(() => {
    r.current.discard = true;
    setReloadTick((t) => t + 1);
  }, []);

  const overwrite = useCallback(() => {
    const s = r.current;
    s.force = true;
    s.conflict = false;
    void doSave();
  }, [doSave]);

  const adoptHead = useCallback((head: NoteView) => adoptOwnHead(store, r.current, head), [store]);

  return { status, loadError, body, setBody, save, saveError, reload, overwrite, adoptHead };
}
