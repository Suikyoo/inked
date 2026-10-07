import { buildEntry, searchTitles } from 'inked-core';
import { describe, expect, it } from 'vitest';
import { buildRows } from './searchRows';

const e = (id: string, title: string) => buildEntry(id, 'v', 'Work', [], title, '2026-10-01T00:00:00.000Z');
const entries = [e('a', 'deploy'), e('b', 'deployment notes'), e('c', 'vehicles')];

describe('buildRows', () => {
  it('pins the exact title, tags rows and appends meaning-only rows', () => {
    // 0.6 similarity scores below the weakest title hit (0.5 after normalisation), so the meaning-only row sorts last.
    const rows = buildRows(searchTitles('deploy', entries), [], [{ noteId: 'c', similarity: 0.6, chunk: 0 }], entries, 'deploy');
    expect(rows[0].entry.noteId).toBe('a');
    expect(rows.map((r) => [r.entry.noteId, r.why])).toEqual([
      ['a', 'title'],
      ['b', 'title'],
      ['c', 'meaning'],
    ]);
    expect(rows[2].titleMatch).toBeNull();
  });
  it('carries body snippets for text hits', () => {
    const snippet = { before: '', hit: 'car', after: ' parts' };
    const rows = buildRows([], [{ entry: entries[2], snippet }], [], entries, 'car');
    expect(rows[0]).toMatchObject({ why: 'text', snippet });
  });
});
