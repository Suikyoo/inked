import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '../api/client';
import { describeError } from '../lib/util';
import { LockedError, type NoteView } from '../state/store';
import { useStore } from '../state/StoreContext';

export type SaveStatus = 'idle' | 'pending' | 'saving' | 'saved' | 'error' | 'conflict';

const AUTOSAVE_MS = 800;

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
  const r = useRef({
    vaultId,
    noteId,
    body: '',
    savedBody: '',
    base: undefined as string | undefined,
    timer: 0 as number | undefined,
    inFlight: null as Promise<void> | null,
    conflict: false,
    force: false,
    alive: true,
  });

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
    s.inFlight = (async () => {
      try {
        const head = await store.saveNoteBody(target.vaultId, target.noteId, snapshot, s.force ? undefined : s.base);
        s.base = head.updatedAt;
        s.savedBody = snapshot;
        s.force = false;
        s.conflict = false;
        if (s.alive) {
          setSaveError(null);
          setSave(s.body === snapshot ? 'saved' : 'pending');
        }
      } catch (e) {
        if (isApiError(e, 409)) {
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
    const s = {
      vaultId,
      noteId,
      body: '',
      savedBody: '',
      base: undefined as string | undefined,
      timer: undefined as number | undefined,
      inFlight: null as Promise<void> | null,
      conflict: false,
      force: false,
      alive: true,
    };
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
    const unregister = store.registerFlusher(() => doSave());
    return () => {
      cancelled = true;
      unregister();
      // Flush pending edits of the note we are leaving.
      window.clearTimeout(s.timer);
      if (s.body !== s.savedBody && !s.conflict) void doSaveFor(s);
      s.alive = false;
    };

    function doSaveFor(state: typeof s) {
      window.clearTimeout(state.timer);
      // Wait for a save already in flight so its new updatedAt becomes the base.
      return (state.inFlight ?? Promise.resolve())
        .then(() =>
          state.body !== state.savedBody
            ? store.saveNoteBody(state.vaultId, state.noteId, state.body, state.base)
            : undefined,
        )
        .catch(() => undefined);
    }
  }, [vaultId, noteId, reloadTick, store, doSave]);

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
      const s = r.current;
      s.body = b;
      setBodyState(b);
      if (s.conflict) return;
      setSave('pending');
      schedule();
    },
    [schedule],
  );

  const reload = useCallback(() => setReloadTick((t) => t + 1), []);

  const overwrite = useCallback(() => {
    const s = r.current;
    s.force = true;
    s.conflict = false;
    void doSave();
  }, [doSave]);

  const adoptHead = useCallback(
    (head: NoteView) => {
      const s = r.current;
      // Only this tab's own writes may move the base; anyone else's change must still raise a conflict.
      if (
        head.id === s.noteId &&
        !s.inFlight &&
        store.isOwnStamp(head.id, head.updatedAt) &&
        (!s.base || head.updatedAt > s.base)
      ) {
        s.base = head.updatedAt;
      }
    },
    [store],
  );

  return { status, loadError, body, setBody, save, saveError, reload, overwrite, adoptHead };
}
