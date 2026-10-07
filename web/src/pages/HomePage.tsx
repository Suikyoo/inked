import { useEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { VaultIcon } from '../brand/VaultIcon';
import { FOCUS_SEARCH_EVENT } from '../components/AppShell';
import { PlusIcon, SearchIcon } from '../components/Icons';
import { uniqueTitle } from '../components/VaultTree';
import { ConceptMap, type MapSelection } from '../map/ConceptMap';
import { useVaultGraphs } from '../map/useVaultGraphs';
import { highlightSegments } from '../search/fuzzy';
import { searchBodies, searchTitles, type SearchEntry } from '../search/search';
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
  const mapEntries = useVaultGraphs(state);
  const hitIds = useMemo(() => new Set([...titleHits, ...bodyHits].map((h) => h.entry.noteId)), [titleHits, bodyHits]);
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
      const first = titleHits[0]?.entry ?? bodyHits[0]?.entry;
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

  const total = titleHits.length + bodyHits.length;

  // A row that newly enters the result set eases in; the first reveal (the previous render had no query)
  // staggers the rows. The flags are frozen when a row enters and kept while its id stays in the set, so
  // typing, hover and store updates do not cut the animation short or replay it.
  const shownIds = column === 'search' ? [...titleHits, ...bodyHits].map((h) => h.entry.noteId) : [];
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
            Matches note titles and folder paths as you type. Press Enter to open the top result, or arrow down to move through results.
          </span>
        </form>
        <div className="home-head-side is-end">
          <button type="button" className="btn btn-primary btn-sm" onClick={newNote} disabled={vaults.length === 0}>
            <PlusIcon size={12} strokeWidth={2.4} />
            New note
          </button>
        </div>
      </header>
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
          onFocus={(e) => setHot(hotFrom(e.target))}
          onBlur={() => setHot(null)}
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
                {treesPending ? 'Searching…' : `${total} ${total === 1 ? 'match' : 'matches'}`}
              </h2>
              <ul className="res-list">
                {titleHits.map(({ entry, match }) => (
                  <li key={entry.noteId} {...rowMotion(entry.noteId)}>
                    <Link className="res" to={hrefFor(entry)} data-note={entry.noteId}>
                      <span className="res-title">
                        <Highlighted text={entry.text.slice(entry.pathStart)} indices={match.indices} offset={entry.pathStart} />
                      </span>
                      <ResultMeta state={state} entry={entry} />
                    </Link>
                  </li>
                ))}
              </ul>
              {bodyHits.length > 0 && (
                <>
                  <h3 className="results-sub">In note text</h3>
                  <ul className="res-list">
                    {bodyHits.map(({ entry, snippet }) => (
                      <li key={entry.noteId} {...rowMotion(entry.noteId)}>
                        <Link className="res" to={hrefFor(entry)} data-note={entry.noteId}>
                          <span className="res-title">{entry.text.slice(entry.pathStart)}</span>
                          <span className="res-snippet">
                            {snippet.before}
                            <mark>{snippet.hit}</mark>
                            {snippet.after}
                          </span>
                          <ResultMeta state={state} entry={entry} />
                        </Link>
                      </li>
                    ))}
                  </ul>
                </>
              )}
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
