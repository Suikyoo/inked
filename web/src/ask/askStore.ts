import {
  buildPrompt,
  chat,
  chunkNote,
  isAllowedBaseUrl,
  LlmError,
  parseCitations,
  RAG_K,
  searchBodies,
  searchTitles,
  type AskTurn,
  type RagSource,
  type SearchEntry,
} from 'inked-core';
import type { AccountSettingsStore } from '../state/accountSettings';
import type { AppStore } from '../state/store';
import type { SemanticStore } from '../semantic/semanticStore';

export type AskErrorKind = 'setup' | 'retrieval' | 'auth' | 'rate' | 'network' | 'http' | 'cut';

export interface AskSource extends RagSource {
  vaultId: string;
}

export interface AskTurnView {
  id: number;
  question: string;
  answer: string;
  sources: AskSource[];
  cited: string[];
  via: 'meaning' | 'text';
  status: 'retrieving' | 'streaming' | 'done' | 'empty' | 'error' | 'stopped';
  error: AskErrorKind | null;
}

export interface AskState {
  turns: AskTurnView[];
  busy: boolean;
}

export interface AskDeps {
  fetch: typeof fetch;
}

type AppLike = Pick<AppStore, 'getState' | 'subscribe' | 'noteHead'>;
type SemanticLike = Pick<SemanticStore, 'retrieveChunks'>;
type AccountLike = Pick<AccountSettingsStore, 'getState'>;

const EMPTY: AskState = { turns: [], busy: false };

/** "Vault / folder/path" from a search entry's "vault / folder/path / title" text. */
const pathOf = (e: SearchEntry) => e.text.slice(0, e.titleStart).replace(/\s*\/\s*$/, '');

/** One conversation with the user's notes: retrieval in the browser, generation at the configured provider. */
export class AskStore {
  private state = EMPTY;
  private listeners = new Set<() => void>();
  private deps: AskDeps;
  private abort: AbortController | null = null;
  private seq = 0;
  private unlocked = false;
  private unsubscribe: () => void;

  constructor(
    private app: AppLike,
    private semantic: SemanticLike,
    private account: AccountLike,
    deps: Partial<AskDeps> = {},
  ) {
    this.deps = { fetch: (...a) => fetch(...a), ...deps };
    this.unsubscribe = app.subscribe(this.onApp);
    this.onApp();
  }

  getState = (): AskState => this.state;

  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private set(patch: Partial<AskState>) {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private patchTurn(id: number, patch: Partial<AskTurnView>) {
    this.set({ turns: this.state.turns.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  }

  dispose(): void {
    this.unsubscribe();
    this.clear();
    this.listeners.clear();
  }

  private onApp = () => {
    const s = this.app.getState();
    const unlocked = s.phase === 'unlocked' && !s.locking;
    if (unlocked === this.unlocked) return;
    this.unlocked = unlocked;
    if (!unlocked) this.clear();
  };

  /** Stops any answer and forgets the conversation. */
  clear(): void {
    this.abort?.abort();
    this.abort = null;
    this.set(EMPTY);
  }

  stop(): void {
    this.abort?.abort();
  }

  async retry(entries: readonly SearchEntry[]): Promise<void> {
    const last = this.state.turns[this.state.turns.length - 1];
    if (!last || this.state.busy) return;
    this.set({ turns: this.state.turns.slice(0, -1) });
    await this.ask(last.question, entries);
  }

  async ask(question: string, entries: readonly SearchEntry[]): Promise<void> {
    const q = question.trim();
    if (!q || !this.unlocked) return;
    let turns = this.state.turns;
    if (this.abort) {
      // A question still in flight is superseded: it ends as stopped, keeping what arrived.
      this.abort.abort();
      turns = turns.map((t) =>
        t.status === 'retrieving' || t.status === 'streaming' ? { ...t, status: 'stopped', cited: parseCitations(t.answer, t.sources) } : t,
      );
    }
    const ac = new AbortController();
    this.abort = ac;
    const history: AskTurn[] = turns.filter((t) => t.status === 'done').map((t) => ({ question: t.question, answer: t.answer }));
    const prev = turns[turns.length - 1]?.question;
    const id = ++this.seq;
    const turn: AskTurnView = { id, question: q, answer: '', sources: [], cited: [], via: 'meaning', status: 'retrieving', error: null };
    // Pushed before the first await, so a caller sees the new turn as soon as ask() returns its promise.
    this.set({ turns: [...turns, turn], busy: true });
    const live = () => this.abort === ac && this.state.turns.some((t) => t.id === id);
    try {
      // The binding check: no request leaves for an origin the operator did not allow.
      const { settings, llmOrigins } = this.account.getState();
      const llm = settings.llm;
      if (!llm || !isAllowedBaseUrl(llm.baseUrl, llmOrigins)) {
        this.patchTurn(id, { status: 'error', error: 'setup' });
        return;
      }
      const byId = new Map(entries.map((e) => [e.noteId, e]));
      // A follow-up retrieves with the previous question too, so "and on staging?" still finds the topic.
      const retrievalQuery = prev ? `${prev}\n${q}` : q;
      let found: { sources: AskSource[]; via: 'meaning' | 'text' };
      try {
        found = await this.sources(retrievalQuery, entries, byId, ac.signal);
      } catch {
        if (live()) this.patchTurn(id, { status: 'error', error: 'retrieval' });
        return;
      }
      if (!live()) return;
      if (ac.signal.aborted) {
        this.patchTurn(id, { status: 'stopped' });
        return;
      }
      const { sources, via } = found;
      if (!sources.length) {
        this.patchTurn(id, { status: 'empty', via });
        return;
      }
      const { messages, used } = buildPrompt(q, sources, history);
      this.patchTurn(id, { status: 'streaming', sources: used as AskSource[], via });
      let answer = '';
      try {
        for await (const d of chat({ ...llm, messages, signal: ac.signal, fetch: this.deps.fetch })) {
          if (!live()) return;
          answer += d;
          this.patchTurn(id, { answer });
        }
      } catch (e) {
        if (!live()) return;
        const kind = e instanceof LlmError ? e.kind : 'http';
        if (kind === 'aborted') this.patchTurn(id, { status: 'stopped', cited: parseCitations(answer, used) });
        else this.patchTurn(id, { status: 'error', error: kind as AskErrorKind, cited: parseCitations(answer, used) });
        return;
      }
      if (!live()) return;
      this.patchTurn(id, { status: 'done', cited: parseCitations(answer, used) });
    } finally {
      if (this.abort === ac) {
        this.abort = null;
        this.set({ busy: false });
      }
    }
  }

  private async sources(
    query: string,
    entries: readonly SearchEntry[],
    byId: Map<string, SearchEntry>,
    signal: AbortSignal,
  ): Promise<{ sources: AskSource[]; via: 'meaning' | 'text' }> {
    const toSource = (noteId: string, text: string, score: number): AskSource | null => {
      const e = byId.get(noteId);
      const head = this.app.noteHead(noteId);
      return e && head ? { noteId, vaultId: head.vaultId, title: head.title, path: pathOf(e), text, score } : null;
    };
    const hits = await this.semantic.retrieveChunks(query, signal);
    if (hits !== null) {
      return { via: 'meaning', sources: hits.map((h) => toSource(h.noteId, h.text, h.score)).filter((s): s is AskSource => !!s) };
    }
    // No model on this browser: the top notes by text, first chunk each, ranked by position.
    const { bodies } = this.app.getState();
    const titles = searchTitles(query, entries, RAG_K);
    const exclude = new Set(titles.map((h) => h.entry.noteId));
    const texts = searchBodies(query, entries, bodies, exclude, RAG_K);
    const ids = [...titles, ...texts].map((h) => h.entry.noteId).slice(0, RAG_K);
    const sources: AskSource[] = [];
    ids.forEach((noteId, i) => {
      const head = this.app.noteHead(noteId);
      const body = bodies[noteId];
      const text = head && body !== undefined ? chunkNote(head.title, body)[0] : undefined;
      const s = text === undefined ? null : toSource(noteId, text, 1 - i / (RAG_K + 1));
      if (s) sources.push(s);
    });
    return { via: 'text', sources };
  }
}
