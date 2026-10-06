import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { buildEntry, type SearchEntry } from '../search/search';
import { AppStore, type AppState, type FolderView, type TreeView, type VaultView } from './store';

const StoreCtx = createContext<AppStore | null>(null);

export function StoreProvider({ store, children }: { store: AppStore; children: ReactNode }) {
  return <StoreCtx.Provider value={store}>{children}</StoreCtx.Provider>;
}

export function useStore(): AppStore {
  const s = useContext(StoreCtx);
  if (!s) throw new Error('StoreProvider missing');
  return s;
}

export function useAppState(): AppState {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getState);
}

// ---- Derived data ------------------------------------------------------------------------

export function folderPath(tree: TreeView | undefined, folderId: string | null): FolderView[] {
  const out: FolderView[] = [];
  const seen = new Set<string>();
  let id = folderId;
  while (id && tree?.folders[id] && !seen.has(id)) {
    seen.add(id);
    out.unshift(tree.folders[id]);
    id = tree.folders[id].parentId;
  }
  return out;
}

const WEEK = 7 * 86400_000;

export interface VaultStats {
  noteCount: number;
  active7d: number;
  /** 0..1 ink level: share of notes edited this week. */
  level: number;
}

export function vaultStats(vault: VaultView, tree: TreeView | undefined, now = Date.now()): VaultStats {
  let noteCount = vault.noteCount;
  let active7d = vault.activeNoteCount7d;
  if (tree?.status === 'ready') {
    const notes = Object.values(tree.notes);
    noteCount = notes.length;
    active7d = notes.filter((n) => now - Date.parse(n.updatedAt) < WEEK).length;
  }
  const level = Math.max(0, Math.min(1, active7d / Math.max(noteCount, 1)));
  return { noteCount, active7d, level };
}

export function useSearchEntries(state: AppState): SearchEntry[] {
  const { trees, vaults, vaultOrder } = state;
  return useMemo(() => {
    const out: SearchEntry[] = [];
    for (const vid of vaultOrder) {
      const v = vaults[vid];
      const tree = trees[vid];
      if (!v || !tree) continue;
      for (const n of Object.values(tree.notes)) {
        const path = folderPath(tree, n.folderId).map((f) => f.name);
        out.push(buildEntry(n.id, vid, v.name, path, n.title, n.updatedAt));
      }
    }
    return out;
  }, [trees, vaults, vaultOrder]);
}

/** Lower-cased title -> note id within one vault (most recently edited wins on duplicates). */
export function titleIndex(tree: TreeView | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!tree) return map;
  const notes = Object.values(tree.notes).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const n of notes) map.set(n.title.trim().toLowerCase(), n.id);
  return map;
}
