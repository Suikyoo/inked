import { describe, expect, it } from 'vitest';
import { fuzzyMatch, highlightSegments } from './fuzzy';
import { buildEntry, makeSnippet, searchBodies, searchTitles } from './search';

describe('fuzzyMatch', () => {
  it('matches subsequences and returns indices', () => {
    const m = fuzzyMatch('dply', 'runbooks/deploy-prod');
    expect(m).not.toBeNull();
    const target = 'runbooks/deploy-prod';
    expect(m!.indices.map((i) => target[i]).join('')).toBe('dply');
    expect(m!.indices).toEqual([...m!.indices].sort((a, b) => a - b));
  });

  it('returns null when the query is not a subsequence or empty', () => {
    expect(fuzzyMatch('xyz', 'deploy-prod')).toBeNull();
    expect(fuzzyMatch('dd', 'd')).toBeNull();
    expect(fuzzyMatch('', 'anything')).toBeNull();
    expect(fuzzyMatch('   ', 'anything')).toBeNull();
    expect(fuzzyMatch('a', '')).toBeNull();
  });

  it('is case-insensitive and ignores spaces in the query', () => {
    expect(fuzzyMatch('DePl', 'deploy')).not.toBeNull();
    expect(fuzzyMatch('dep loy', 'Deploy')!.indices).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('prefers consecutive runs', () => {
    const a = fuzzyMatch('deploy', 'deploy-notes')!;
    const b = fuzzyMatch('deploy', 'd-e-p-l-o-y-xx')!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('prefers word starts', () => {
    const a = fuzzyMatch('dr', 'deploy-rollback')!;
    const b = fuzzyMatch('dr', 'adorable-xxxxxx')!;
    expect(a.score).toBeGreaterThan(b.score);
    expect(a.indices).toEqual([0, 7]);
  });

  it('treats camelCase humps as word starts', () => {
    const m = fuzzyMatch('ws', 'wireguardSetup')!;
    expect(m.indices).toEqual([0, 9]);
  });

  it('penalises longer targets for otherwise equal matches', () => {
    const a = fuzzyMatch('raft', 'raft')!;
    const b = fuzzyMatch('raft', 'raft-consensus-paper-notes')!;
    expect(a.score).toBeGreaterThan(b.score);
  });

  it('finds the best alignment, not the first greedy one', () => {
    // Greedy would take a@1, b@5; the consecutive "ab" at 4..5 scores higher.
    expect(fuzzyMatch('ab', 'xa_yab')!.indices).toEqual([4, 5]);
  });

  it('boosts matches in the title part', () => {
    const t = 'notes / notes';
    const m = fuzzyMatch('notes', t, { boostFrom: 8 })!;
    expect(m.indices).toEqual([8, 9, 10, 11, 12]);
  });
});

describe('highlightSegments', () => {
  it('splits into runs', () => {
    expect(highlightSegments('deploy', [0, 1, 4])).toEqual([
      { text: 'de', hit: true },
      { text: 'pl', hit: false },
      { text: 'o', hit: true },
      { text: 'y', hit: false },
    ]);
  });

  it('supports an offset for substrings', () => {
    expect(highlightSegments('abc', [5, 7], 5)).toEqual([
      { text: 'a', hit: true },
      { text: 'b', hit: false },
      { text: 'c', hit: true },
    ]);
  });
});

describe('searchTitles / searchBodies', () => {
  const entries = [
    buildEntry('n1', 'v1', 'Work', ['runbooks'], 'deploy-prod', '2026-10-01T00:00:00Z'),
    buildEntry('n2', 'v1', 'Work', ['runbooks'], 'deploy-rollback', '2026-10-02T00:00:00Z'),
    buildEntry('n3', 'v2', 'Homelab', ['docker'], 'compose-stacks', '2026-10-03T00:00:00Z'),
    buildEntry('n4', 'v2', 'Homelab', [], 'Daily log', '2026-10-04T00:00:00Z'),
  ];

  it('builds "vault / folder/path / title"', () => {
    expect(entries[0].text).toBe('Work / runbooks / deploy-prod');
    expect(entries[0].text.slice(entries[0].titleStart)).toBe('deploy-prod');
    expect(entries[3].text).toBe('Homelab / Daily log');
    expect(buildEntry('x', 'v', 'V', ['a', 'b'], 't', '').text).toBe('V / a/b / t');
  });

  it('ranks title matches', () => {
    const hits = searchTitles('dprod', entries);
    expect(hits[0].entry.noteId).toBe('n1');
    expect(searchTitles('compose', entries).map((h) => h.entry.noteId)).toEqual(['n3']);
    expect(searchTitles('qqq', entries)).toEqual([]);
  });

  it('finds body substrings with snippets and skips excluded notes', () => {
    const bodies = { n1: 'Run the migration as a dry run first.', n2: 'nothing', n3: 'The MIGRATION plan' };
    const hits = searchBodies('migration', entries, bodies, new Set(['n3']));
    expect(hits.map((h) => h.entry.noteId)).toEqual(['n1']);
    expect(hits[0].snippet.hit.toLowerCase()).toBe('migration');
    expect(searchBodies('m', entries, bodies, new Set())).toEqual([]);
  });

  it('makes bounded snippets', () => {
    const body = 'word '.repeat(50) + 'needle' + ' tail'.repeat(50);
    const s = makeSnippet(body, body.indexOf('needle'), 6);
    expect(s.hit).toBe('needle');
    expect(s.before.startsWith('…')).toBe(true);
    expect(s.after.endsWith('…')).toBe(true);
    expect((s.before + s.hit + s.after).length).toBeLessThan(120);
  });
});
