import type { TreeView } from '../state/store';

/** Lower-cased title -> note id within one vault (most recently edited wins on duplicates). */
export function titleIndex(tree: TreeView | undefined): Map<string, string> {
  const map = new Map<string, string>();
  if (!tree) return map;
  const notes = Object.values(tree.notes).sort((a, b) => a.updatedAt.localeCompare(b.updatedAt));
  for (const n of notes) map.set(n.title.trim().toLowerCase(), n.id);
  return map;
}
