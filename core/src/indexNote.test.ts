import { describe, expect, it } from 'vitest';
import type { IndexCandidate, IndexTree } from './indexNote';
import { INDEX_TITLE, indexBody, indexNoteOf, isIndexNote } from './indexNote';
type NoteView = IndexCandidate & { vaultId: string; size: number; updatedAt: string };
type TreeView = IndexTree<NoteView> & { status: 'ready'; folders: Record<string, never> };

const note = (id: string, o: Partial<NoteView> = {}): NoteView => ({
  id, vaultId: 'v', folderId: null, title: INDEX_TITLE, size: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', ...o,
});
const treeOf = (...ns: NoteView[]): TreeView => ({ status: 'ready', folders: {}, notes: Object.fromEntries(ns.map((n) => [n.id, n])) });

describe('indexNote', () => {
  it('builds the default body', () => {
    expect(indexBody('Work')).toBe('# Work\n\nDescribe what lives in this folder.\n');
  });
  it('matches the exact title only', () => {
    expect(indexNoteOf(treeOf(note('a')), null)?.id).toBe('a');
    expect(indexNoteOf(treeOf(note('a', { title: 'index' }), note('b', { title: 'Index ' })), null)).toBeNull();
  });
  it('picks the oldest, then the lowest id', () => {
    expect(indexNoteOf(treeOf(note('a', { createdAt: '2026-02-01' }), note('b', { createdAt: '2026-01-01' })), null)?.id).toBe('b');
    expect(indexNoteOf(treeOf(note('z'), note('m')), null)?.id).toBe('m');
  });
  it('separates root from folders', () => {
    const t = treeOf(note('r'), note('f', { folderId: 'F' }));
    expect(indexNoteOf(t, null)?.id).toBe('r');
    expect(indexNoteOf(t, 'F')?.id).toBe('f');
    expect(indexNoteOf(t, 'G')).toBeNull();
  });
  it('ignores broken notes', () => {
    expect(indexNoteOf(treeOf(note('a', { broken: true })), null)).toBeNull();
    expect(indexNoteOf(treeOf(note('a', { broken: true }), note('b', { createdAt: '2027-01-01' })), null)?.id).toBe('b');
  });
  it('is null once the Index is deleted or renamed', () => {
    const t = treeOf(note('a'));
    expect(indexNoteOf(t, null)?.id).toBe('a');
    expect(indexNoteOf(treeOf(), null)).toBeNull();
    expect(indexNoteOf(treeOf(note('a', { title: 'Notes' })), null)).toBeNull();
  });
  it('isIndexNote is true only for the winner', () => {
    const a = note('a'), b = note('b', { createdAt: '2027-01-01' });
    const t = treeOf(a, b);
    expect(isIndexNote(t, a)).toBe(true);
    expect(isIndexNote(t, b)).toBe(false);
  });
});
