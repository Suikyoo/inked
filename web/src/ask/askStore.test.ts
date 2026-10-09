import { describe, expect, it, vi } from 'vitest';
import type { SearchEntry } from 'inked-core';
import { AskStore } from './askStore';

const enc = new TextEncoder();
const sse = (parts: string[], done = true) =>
  new Response(
    new ReadableStream({
      start(c) {
        for (const p of parts) c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
        if (done) c.enqueue(enc.encode('data: [DONE]\n\n'));
        c.close();
      },
    }),
    { status: 200 },
  );

function fakeApp() {
  let state: any = {
    phase: 'unlocked',
    locking: false,
    bodies: { a: 'Deploy flips the release link.', b: 'Drill found migrations need a down step.' },
  };
  const ls = new Set<() => void>();
  const heads: Record<string, any> = {
    a: { id: 'a', vaultId: 'v', folderId: null, title: 'Deploy runbook', updatedAt: 't' },
    b: { id: 'b', vaultId: 'v', folderId: 'f', title: 'Rollback drill', updatedAt: 't' },
  };
  return {
    getState: () => state,
    subscribe: (f: () => void) => (ls.add(f), () => ls.delete(f)),
    set(p: any) {
      state = { ...state, ...p };
      ls.forEach((f) => f());
    },
    noteHead: (id: string) => heads[id],
  };
}
const entries: SearchEntry[] = [
  { noteId: 'a', vaultId: 'v', text: 'Work / Deploy runbook', pathStart: 7, titleStart: 7, updatedAt: 't' },
  { noteId: 'b', vaultId: 'v', text: 'Work / Ops/Rollback drill', pathStart: 7, titleStart: 11, updatedAt: 't' },
];
const llm = { baseUrl: 'https://api.openai.com/v1', model: 'm', apiKey: 'k' };
function account(settings: any = { llm }, origins = ['https://api.openai.com']) {
  return { getState: () => ({ loaded: true, settings, unreadable: false, llmOrigins: origins }), subscribe: () => () => undefined };
}
function semantic(hits: any[] | null) {
  return { retrieveChunks: vi.fn(async () => hits) };
}
const meaningHits = [
  { noteId: 'b', vaultId: 'v', chunk: 0, score: 0.8, text: 'Rollback drill\nDrill found migrations need a down step.' },
  { noteId: 'a', vaultId: 'v', chunk: 0, score: 0.7, text: 'Deploy runbook\nDeploy flips the release link.' },
];

function make(over: { fetch?: any; hits?: any[] | null; settings?: any; origins?: string[] } = {}) {
  const app = fakeApp();
  const f = over.fetch ?? vi.fn(async () => sse(['Flip the link ', '[[deploy runbook]].']));
  const store = new AskStore(app as any, semantic(over.hits === undefined ? meaningHits : over.hits) as any, account(over.settings, over.origins) as any, { fetch: f });
  return { app, f, store };
}

describe('AskStore', () => {
  it('retrieves by meaning, streams the answer and resolves citations', async () => {
    const { store, f } = make();
    await store.ask('How do I roll back?', entries);
    const [turn] = store.getState().turns;
    expect(turn).toMatchObject({ question: 'How do I roll back?', answer: 'Flip the link [[deploy runbook]].', status: 'done', via: 'meaning', cited: ['a'] });
    expect(turn.sources.map((s) => s.noteId)).toEqual(['b', 'a']);
    expect(turn.sources[1]).toMatchObject({ title: 'Deploy runbook', path: 'Work', vaultId: 'v' });
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.messages.at(-1).content).toContain('Question: How do I roll back?');
    expect(store.getState().busy).toBe(false);
  });
  it('falls back to text search when the model is not ready', async () => {
    const { store } = make({ hits: null });
    await store.ask('rollback drill', entries);
    const [turn] = store.getState().turns;
    expect(turn.via).toBe('text');
    expect(turn.sources[0]).toMatchObject({ noteId: 'b', text: 'Rollback drill\nDrill found migrations need a down step.' });
  });
  it('makes no LLM call when nothing matches', async () => {
    const { store, f } = make({ hits: [] });
    await store.ask('zzzz qqqq', entries);
    expect(store.getState().turns[0].status).toBe('empty');
    expect(f).not.toHaveBeenCalled();
  });
  it('reports setup when Ask is not configured or the base URL is not allowed', async () => {
    for (const over of [{ settings: {} }, { origins: ['https://other.example'] }]) {
      const { store, f } = make(over);
      await store.ask('q', entries);
      expect(store.getState().turns[0]).toMatchObject({ status: 'error', error: 'setup' });
      expect(f).not.toHaveBeenCalled();
    }
  });
  it('maps provider errors and keeps partial text when cut', async () => {
    const auth = make({ fetch: vi.fn(async () => new Response('{}', { status: 401 })) });
    await auth.store.ask('q', entries);
    expect(auth.store.getState().turns[0]).toMatchObject({ status: 'error', error: 'auth' });
    const cut = make({ fetch: vi.fn(async () => sse(['partial'], false)) });
    await cut.store.ask('q', entries);
    expect(cut.store.getState().turns[0]).toMatchObject({ status: 'error', error: 'cut', answer: 'partial' });
  });
  it('sends earlier turns as history for a follow-up', async () => {
    const { store, f } = make();
    await store.ask('first', entries);
    await store.ask('second', entries);
    const body = JSON.parse((f.mock.calls[1][1] as RequestInit).body as string);
    expect(body.messages.slice(1, 3)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'Flip the link [[deploy runbook]].' },
    ]);
  });
  it('stop aborts the stream and keeps what arrived', async () => {
    let release!: () => void;
    const f = vi.fn(async (_u: string, init: RequestInit) => {
      return new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'so far' } }] })}\n\n`));
            release = () => c.error(new Error('aborted'));
            init.signal?.addEventListener('abort', () => release());
          },
        }),
        { status: 200 },
      );
    });
    const { store } = make({ fetch: f });
    const p = store.ask('q', entries);
    await vi.waitFor(() => expect(store.getState().turns[0]?.answer).toBe('so far'));
    store.stop();
    await p;
    expect(store.getState().turns[0]).toMatchObject({ status: 'stopped', answer: 'so far' });
  });
  it('retry re-asks the last question in place', async () => {
    const f = vi.fn().mockResolvedValueOnce(new Response('{}', { status: 500 })).mockResolvedValueOnce(sse(['ok']));
    const { store } = make({ fetch: f });
    await store.ask('q', entries);
    await store.retry(entries);
    expect(store.getState().turns).toHaveLength(1);
    expect(store.getState().turns[0]).toMatchObject({ status: 'done', answer: 'ok' });
  });
  it('lock aborts the stream and clears everything', async () => {
    const { store, app } = make();
    await store.ask('q', entries);
    app.set({ locking: true });
    expect(store.getState()).toEqual({ turns: [], busy: false });
  });
});
