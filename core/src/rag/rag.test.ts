import { describe, expect, it } from 'vitest';
import { answerToNote, buildPrompt, parseCitations, RAG_SYSTEM, retrieve, type RagSource } from './index';

const unit = (i: number, j?: number) => {
  const v = new Float32Array(4);
  v[i] = 1;
  if (j !== undefined) {
    v[j] = 1;
    const n = Math.SQRT2;
    v[i] /= n;
    v[j] /= n;
  }
  return v;
};

describe('retrieve', () => {
  const q = unit(0);
  it('ranks chunks by cosine, applies the floor and k', () => {
    const hits = retrieve(q, [
      { noteId: 'a', chunks: [unit(0)] },
      { noteId: 'b', chunks: [unit(0, 1)] },
      { noteId: 'c', chunks: [unit(2)] },
    ], { k: 2, floor: 0.45 });
    expect(hits.map((h) => h.noteId)).toEqual(['a', 'b']);
    expect(hits[0].score).toBeCloseTo(1);
  });
  it('keeps at most perNote chunks of one note', () => {
    const hits = retrieve(q, [{ noteId: 'a', chunks: [unit(0), unit(0), unit(0, 1)] }, { noteId: 'b', chunks: [unit(0, 2)] }], { perNote: 2 });
    expect(hits.map((h) => `${h.noteId}${h.chunk}`)).toEqual(['a0', 'a1', 'b0']);
  });
  it('returns nothing below the floor', () => {
    expect(retrieve(q, [{ noteId: 'c', chunks: [unit(2)] }])).toEqual([]);
  });
});

const src = (noteId: string, title: string, words: number, score: number): RagSource => ({
  noteId,
  title,
  path: 'Work / Projects',
  text: Array.from({ length: words }, () => 'w').join(' '),
  score,
});

describe('buildPrompt', () => {
  it('numbers sources, ends with the question and starts with the system rule', () => {
    const { messages, used } = buildPrompt('What is X?', [src('a', 'Alpha', 3, 0.9), src('b', 'Beta', 3, 0.8)], []);
    expect(messages[0]).toEqual({ role: 'system', content: RAG_SYSTEM });
    const last = messages[messages.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toContain('[1] Alpha (Work / Projects)');
    expect(last.content).toContain('[2] Beta (Work / Projects)');
    expect(last.content.trimEnd().endsWith('Question: What is X?')).toBe(true);
    expect(used.map((s) => s.noteId)).toEqual(['a', 'b']);
  });
  it('drops the lowest-scoring sources past the budget but keeps at least one', () => {
    const { used } = buildPrompt('q', [src('low', 'Low', 100, 0.5), src('high', 'High', 100, 0.9)], [], 140);
    expect(used.map((s) => s.noteId)).toEqual(['high']);
    expect(buildPrompt('q', [src('big', 'Big', 1000, 0.9)], [], 10).used).toHaveLength(1);
  });
  it('sends only the last 6 turns as alternating history', () => {
    const history = Array.from({ length: 8 }, (_, i) => ({ question: `q${i}`, answer: `a${i}` }));
    const { messages } = buildPrompt('now', [src('a', 'A', 1, 0.9)], history);
    const middle = messages.slice(1, -1);
    expect(middle).toHaveLength(12);
    expect(middle[0]).toEqual({ role: 'user', content: 'q2' });
    expect(middle[1]).toEqual({ role: 'assistant', content: 'a2' });
  });
});

describe('parseCitations', () => {
  const sources = [
    { noteId: 'a', title: 'Deploy runbook' },
    { noteId: 'b', title: 'Rollback drill' },
  ];
  it('maps titles to ids in order of first appearance, case-insensitively', () => {
    expect(parseCitations('See [[rollback drill]] and [[Deploy runbook]], again [[Rollback drill|here]].', sources)).toEqual(['b', 'a']);
  });
  it('drops titles that are not sources', () => {
    expect(parseCitations('[[Nope]] [[Deploy runbook]]', sources)).toEqual(['a']);
  });
});

describe('answerToNote', () => {
  it('builds a title and a Sources section', () => {
    const n = answerToNote('  How does   rollback work? ', 'It flips the link.', [{ title: 'Deploy runbook' }]);
    expect(n.title).toBe('How does rollback work?');
    expect(n.body).toBe('It flips the link.\n\n## Sources\n\n- [[Deploy runbook]]\n');
  });
  it('cuts long titles to 80 characters and omits Sources without citations', () => {
    const n = answerToNote('x'.repeat(200), 'A', []);
    expect(n.title).toHaveLength(80);
    expect(n.title.endsWith('…')).toBe(true);
    expect(n.body).toBe('A\n');
  });
});
