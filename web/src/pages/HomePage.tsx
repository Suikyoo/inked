import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { VaultIcon } from '../brand/VaultIcon';
import { FOCUS_SEARCH_EVENT } from '../components/AppShell';
import { PlusIcon, SearchIcon } from '../components/Icons';
import { uniqueTitle } from '../components/VaultTree';
import { ConceptMap, type MapSelection } from '../map/ConceptMap';
import { useVaultGraphs } from '../map/useVaultGraphs';
import { highlightSegments, searchBodies, searchTitles, type SearchEntry, type SemanticInput } from 'inked-core';
import { ProgressBar } from '../components/ProgressBar';
import { usePresence } from '../motion';
import { useSemantic, useSemanticStore } from '../semantic/SemanticContext';
import { buildRows, type SearchRow } from './searchRows';
import { describeError, relativeTime } from '../lib/util';
import { NodePreview } from './NodePreview';
import { homeColumn, homeError, homePending } from './homeStatus';
import { useAppState, useSearchEntries, useStore, vaultStats } from '../state/StoreContext';
import type { AppState } from '../state/store';

interface RowFlags {
  fresh: boolean;
  stagger: number | null;
}

/** The first reveal staggers at most this many rows. */
const STAGGER_ROWS = 8;
/** Wait this long after the last keystroke before asking for meaning matches. */
const SEMANTIC_DEBOUNCE_MS = 250;
const toMB = (bytes: number) => Math.round(bytes / 1e6);

function Highlighted({ text, indices, offset }: { text: string; indices: number[]; offset: number }) {
  return (
    <>
      {highlightSegments(text, indices, offset).map((s, i) => (s.hit ? <mark key={i}>{s.text}</mark> : <span key={i}>{s.text}</span>))}
    </>
  );
}

function ResultMeta({ state, entry }: { state: AppState; entry: SearchEntry }) {
  const v = state.vaults[entry.vaultId];
  if (!v) return null;
  const stats = vaultStats(v, state.trees[v.id]);
  return (
    <span className="res-meta">
      <VaultIcon color={v.color} level={stats.level} size={11} />
      {v.name} · {relativeTime(entry.updatedAt)}
    </span>
  );
}

export function HomePage() {
  const state = useAppState();
  const store = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const semanticStore = useSemanticStore();
  const sem = useSemantic();
  const entries = useSearchEntries(state);
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const focus = () => {
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener(FOCUS_SEARCH_EVENT, focus);
    if ((location.state as { focusSearch?: boolean } | null)?.focusSearch) {
      focus();
      navigate('.', { replace: true, state: null });
    }
    return () => window.removeEventListener(FOCUS_SEARCH_EVENT, focus);
  }, [location.state, navigate]);

  const q = query.trim();
  const titleHits = useMemo(() => (q ? searchTitles(q, entries, 30) : []), [q, entries]);
  const bodyHits = useMemo(() => {
    if (q.length < 2) return [];
    const exclude = new Set(titleHits.map((h) => h.entry.noteId));
    return searchBodies(q, entries, state.bodies, exclude, 15);
  }, [q, entries, state.bodies, titleHits]);
  const [semantic, setSemantic] = useState<SemanticInput[]>([]);
  const semReady = sem.phase === 'ready';
  useEffect(() => {
    if (q.length < 3 || !semReady) {
      setSemantic((prev) => (prev.length ? [] : prev));
      return;
    }
    const abort = new AbortController();
    const timer = setTimeout(() => {
      semanticStore
        .search(q, abort.signal)
        .then((r) => {
          if (!abort.signal.aborted) setSemantic(r);
        })
        .catch(() => {
          if (!abort.signal.aborted) setSemantic([]);
        });
    }, SEMANTIC_DEBOUNCE_MS);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [q, semReady, semanticStore]);
  const liveRows = useMemo(() => buildRows(titleHits, bodyHits, semantic, entries, q), [titleHits, bodyHits, semantic, entries, q]);
  // While focus is inside the list the rows hold still, so a late meaning result cannot move what the reader is
  // about to open. The new rows wait in liveRows and apply when focus leaves the list or the query changes.
  const browsing = useRef(false);
  const shown = useRef<{ q: string; rows: SearchRow[] } | null>(null);
  const [, setTick] = useState(0);
  const held = browsing.current && shown.current?.q === q ? shown.current.rows : null;
  const rows = held ?? liveRows;
  shown.current = { q, rows };
  const mapEntries = useVaultGraphs(state);
  const hitIds = useMemo(() => new Set(rows.map((r) => r.entry.noteId)), [rows]);
  const [hot, setHot] = useState<string | null>(null);
  // The map rings and inks the selected node; the right column previews it.
  const [selected, setSelected] = useState<MapSelection | null>(null);
  const [fitRequest, setFitRequest] = useState<{ sel: MapSelection; n: number } | null>(null);
  const column = homeColumn(state, query, selected);
  const hotFrom = (t: EventTarget) => (t instanceof Element ? t.closest('a.res')?.getAttribute('data-note') ?? null : null);

  const bodiesPending = state.vaultOrder.some((id) => !state.vaults[id]?.broken && !state.bodiesReady[id]);
  const treesPending = homePending(state);
  const vaults = state.vaultOrder.map((id) => state.vaults[id]).filter((v) => v && !v.broken);

  const hrefFor = (e: SearchEntry) => `/v/${e.vaultId}/n/${e.noteId}`;

  const results = () => listRef.current?.querySelectorAll<HTMLAnchorElement>('a.res') ?? [];

  const onInputKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (query) setQuery('');
      else inputRef.current?.blur();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      results()[0]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const first = rows[0]?.entry;
      if (first) navigate(hrefFor(first));
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = Array.from(results());
    const i = items.indexOf(document.activeElement as HTMLAnchorElement);
    if (i < 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[Math.min(i + 1, items.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (i === 0) inputRef.current?.focus();
      else items[i - 1]?.focus();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      setQuery('');
      inputRef.current?.focus();
    }
  };

  const newNote = async () => {
    const target = vaults[0];
    if (!target) return;
    setError(null);
    try {
      const head = await store.createNote(target.id, null, uniqueTitle(state.trees[target.id]));
      navigate(`/v/${target.id}/n/${head.id}`, { state: { fresh: true } });
    } catch (e) {
      setError(describeError(e));
    }
  };

  const total = rows.length;
  const cov = Object.values(sem.coverage).reduce((a, c) => ({ done: a.done + c.done, total: a.total + c.total }), { done: 0, total: 0 });
  const incomplete = cov.done < cov.total;
  const indexing = sem.enabled && semReady && incomplete;
  const downloading = sem.phase === 'downloading' && sem.download !== null;
  const barNow = downloading
    ? { label: `Downloading model · ${toMB(sem.download!.loaded)} / ${toMB(sem.download!.total)} MB`, value: sem.download!.loaded, max: sem.download!.total }
    : { label: `Indexing by meaning · ${cov.done} / ${cov.total}`, value: cov.done, max: cov.total };
  const bar = usePresence(indexing || downloading, 200);
  // The label outlives the state that earned it while the bar fades out.
  const lastBar = useRef(barNow);
  if (indexing || downloading) lastBar.current = barNow;

  // A row that newly enters the result set eases in; the first reveal (the previous render had no query)
  // staggers the rows. The flags are frozen when a row enters and kept while its id stays in the set, so
  // typing, hover and store updates do not cut the animation short or replay it.
  const shownIds = column === 'search' ? rows.map((r) => r.entry.noteId) : [];
  const rowFlags = useRef(new Map<string, RowFlags>());
  const wasIdle = useRef(true);
  const flags = new Map<string, RowFlags>();
  shownIds.forEach((id, i) => flags.set(id, rowFlags.current.get(id) ?? { fresh: true, stagger: wasIdle.current ? Math.min(i, STAGGER_ROWS - 1) : null }));
  useEffect(() => {
    rowFlags.current = flags;
    wasIdle.current = !q;
  });
  const rowMotion = (id: string) => {
    const f = flags.get(id);
    return {
      'data-new': f?.fresh ? '' : undefined,
      style: f?.fresh && f.stagger != null ? ({ '--i': f.stagger } as CSSProperties) : undefined,
      // Once the entry animation has finished the flag is spent; the next render drops it with no visible change.
      onAnimationEnd: () => {
        if (f) f.fresh = false;
      },
    };
  };

  return (
    <div className="home">
      <header className="home-head">
        <div className="home-head-side" />
        <form role="search" className="search" onSubmit={(e) => e.preventDefault()}>
          <SearchIcon className="search-icon" />
          <label htmlFor="q" className="sr-only">
            Search all vaults
          </label>
          <input
            ref={inputRef}
            id="q"
            type="search"
            autoComplete="off"
            spellCheck={false}
            placeholder="Search Inked"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onInputKey}
            aria-controls="results"
            aria-describedby="search-help"
          />
          <kbd aria-hidden="true">/</kbd>
          <span id="search-help" className="sr-only">
            Matches note titles and folder paths as you type. Press Enter to open the top result, or arrow down to move through results. With search by meaning on, results also include notes about the same topic.
          </span>
        </form>
        <div className="home-head-side is-end">
          <button type="button" className="btn btn-primary btn-sm" onClick={newNote} disabled={vaults.length === 0}>
            <PlusIcon size={12} strokeWidth={2.4} />
            New note
          </button>
        </div>
      </header>
      {bar.mounted && (
        <div className="home-index" ref={bar.ref} data-state={bar.state}>
          <ProgressBar value={lastBar.current.value} max={lastBar.current.max} label={lastBar.current.label} />
        </div>
      )}
      {error && (
        <p className="form-error home-error" role="alert">
          {error}
        </p>
      )}

      <div className="home-body">
        {(state.vaultsStatus !== 'ready' || vaults.length > 0) && (
          <section className="map" aria-label="Concept map">
            <ConceptMap entries={mapEntries} hits={hitIds} hot={hot} loading={treesPending} selected={selected} onSelect={setSelected} fitRequest={fitRequest} />
          </section>
        )}

        <aside
          className="results"
          aria-label={column === 'search' ? 'Search results' : 'Preview'}
          id="results"
          ref={listRef}
          onKeyDown={onListKey}
          onMouseOver={(e) => setHot(hotFrom(e.target))}
          onMouseLeave={() => setHot(null)}
          onFocus={(e) => {
            setHot(hotFrom(e.target));
            browsing.current = true;
          }}
          onBlur={(e) => {
            setHot(null);
            const next = e.relatedTarget;
            if (browsing.current && !(next instanceof Node && e.currentTarget.contains(next))) {
              browsing.current = false;
              setTick((n) => n + 1);
            }
          }}
        >
          {homeError(state) ? (
            <div className="empty">
              <p>
                Couldn’t load your vaults.{' '}
                <button type="button" className="linkish" onClick={() => void store.loadAll().catch(() => undefined)}>
                  Try again
                </button>
              </p>
            </div>
          ) : state.vaultsStatus === 'ready' && vaults.length === 0 ? (
            <div className="empty">
              <p>You don’t have any vaults yet. A vault holds folders and notes, each encrypted with its own key.</p>
              <p>Use the + next to “Vaults” in the sidebar to create one.</p>
            </div>
          ) : column === 'search' ? (
            <>
              <h2 className="results-title" aria-live="polite">
                {treesPending ? 'Searching…' : `${total} ${total === 1 ? 'match' : 'matches'}${semReady && incomplete ? ` · meaning covers ${cov.done} of ${cov.total} notes` : ''}`}
              </h2>
              <ul className="res-list">
                {rows.map(({ entry, why, titleMatch, snippet, chunk }) => {
                  const line = why === 'meaning' && chunk !== null ? semanticStore.chunkText(entry.noteId, chunk)?.split('\n')[0] : null;
                  return (
                    <li key={entry.noteId} {...rowMotion(entry.noteId)}>
                      <Link className="res" to={hrefFor(entry)} data-note={entry.noteId}>
                        <span className="res-title">
                          {titleMatch ? (
                            <Highlighted text={entry.text.slice(entry.pathStart)} indices={titleMatch.indices} offset={entry.pathStart} />
                          ) : (
                            entry.text.slice(entry.pathStart)
                          )}
                        </span>
                        {snippet && why === 'text' && (
                          <span className="res-snippet">
                            {snippet.before}
                            <mark>{snippet.hit}</mark>
                            {snippet.after}
                          </span>
                        )}
                        {line && <span className="res-snippet">{line}</span>}
                        <span className="res-why" data-why={why}>
                          {why === 'meaning' ? '◇ meaning' : why}
                        </span>
                        <ResultMeta state={state} entry={entry} />
                      </Link>
                    </li>
                  );
                })}
              </ul>
              {total === 0 && !treesPending && (
                <p className="empty">No notes match “{q}”. Try fewer letters.</p>
              )}
              {bodiesPending && q.length >= 2 && <p className="results-note">Still decrypting note text, so some matches may be missing.</p>}
            </>
          ) : column === 'preview' && selected ? (
            <NodePreview selection={selected} onZoom={(sel) => setFitRequest((r) => ({ sel, n: (r?.n ?? 0) + 1 }))} />
          ) : (
            <div className="empty">
              <p>Select a folder or note on the map.</p>
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
