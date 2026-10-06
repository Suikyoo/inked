import { useEffect, useMemo, useRef, useState, type MouseEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Spinner } from '../components/Fields';
import { renderMarkdown, toggleTaskAtLine } from '../markdown/render';
import { incomingLinks } from '../map/graph';
import { LocalMap } from '../map/LocalMap';
import { useVaultGraph } from '../map/useVaultGraphs';
import { prefs } from '../lib/prefs';
import { describeError, formatDate, relativeTime, wordCount } from '../lib/util';
import { folderPath, titleIndex, useAppState, useStore, vaultStats } from '../state/StoreContext';
import type { VaultView } from '../state/store';
import { useNoteEditor, type SaveStatus } from './useNoteEditor';

const SAVE_LABEL: Record<SaveStatus, string> = {
  idle: '',
  pending: 'Edited',
  saving: 'Saving…',
  saved: 'Saved',
  error: 'Couldn’t save',
  conflict: 'Not saved',
};

/** The parts of a click on rendered Markdown that decide where it goes. */
export type LinkClick = Pick<
  MouseEvent<HTMLElement>,
  'button' | 'ctrlKey' | 'metaKey' | 'shiftKey' | 'altKey' | 'preventDefault'
> & { target: EventTarget | null };

/**
 * A plain left click on an internal or wiki link goes through the router. Any other button or a
 * modifier (new tab, new window, download) is left to the browser.
 */
export function followNoteLink(e: LinkClick, navigate: (to: string) => void): void {
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  const a = e.target instanceof Element ? e.target.closest('a') : null;
  if (a?.hasAttribute('data-wikilink') || a?.getAttribute('data-internal') === '1') {
    e.preventDefault();
    const href = a.getAttribute('href');
    if (href) navigate(href);
  }
}

export function NotePane({ vault, noteId }: { vault: VaultView; noteId: string }) {
  const state = useAppState();
  const store = useStore();
  const navigate = useNavigate();
  const location = useLocation();
  const editor = useNoteEditor(vault.id, noteId);
  const tree = state.trees[vault.id];
  const head = tree?.notes[noteId];
  const fresh = (location.state as { fresh?: boolean } | null)?.fresh === true;

  const [mode, setMode] = useState<'edit' | 'view'>('view');
  const [title, setTitle] = useState(head?.title ?? '');
  const [titleError, setTitleError] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);

  // Pick the initial mode once the note has loaded.
  useEffect(() => {
    if (editor.status !== 'ready') return;
    const startEdit = fresh || editor.body.trim() === '';
    setMode(startEdit ? 'edit' : 'view');
    if (fresh) {
      window.setTimeout(() => {
        titleRef.current?.focus();
        titleRef.current?.select();
      }, 0);
      navigate('.', { replace: true, state: null });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editor.status, noteId]);

  useEffect(() => {
    if (head && document.activeElement !== titleRef.current) setTitle(head.title);
  }, [head?.title, head]);

  // Keep the conflict base in step with renames/moves made in this browser.
  useEffect(() => {
    if (head) editor.adoptHead(head);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [head?.updatedAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'e') {
        e.preventDefault();
        setMode((m) => (m === 'edit' ? 'view' : 'edit'));
      } else if (k === 's') {
        e.preventDefault();
        editor.setBody(textRef.current?.value ?? editor.body);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editor]);

  const titles = useMemo(() => titleIndex(tree), [tree]);
  const html = useMemo(() => {
    if (mode !== 'view' || editor.status !== 'ready') return '';
    return renderMarkdown(editor.body, {
      resolveWikiLink: (t) => {
        const id = titles.get(t.trim().toLowerCase());
        return id ? `/v/${vault.id}/n/${id}` : null;
      },
    });
  }, [mode, editor.status, editor.body, titles, vault.id]);

  const graph = useVaultGraph(state, vault.id);
  const backlinks = useMemo(() => (graph ? incomingLinks(graph, noteId) : []), [graph, noteId]);

  const commitTitle = async () => {
    const next = title.trim();
    if (!head) return;
    if (!next) {
      setTitle(head.title);
      return;
    }
    if (next === head.title) return;
    setTitleError(null);
    try {
      const h = await store.renameNote(vault.id, noteId, next);
      editor.adoptHead(h);
    } catch (e) {
      setTitleError(describeError(e));
      setTitle(head.title);
    }
  };

  const onArticleClick = (e: MouseEvent<HTMLElement>) => {
    const t = e.target as HTMLElement;
    if (t instanceof HTMLInputElement && t.classList.contains('task-checkbox')) {
      const line = Number(t.dataset.line);
      const next = Number.isInteger(line) ? toggleTaskAtLine(editor.body, line) : null;
      if (next !== null) editor.setBody(next);
      else e.preventDefault();
      return;
    }
    followNoteLink(e, navigate);
  };

  if (editor.status === 'error') {
    return (
      <div className="doc-empty">
        <p>{editor.loadError}</p>
        <Link to={`/v/${vault.id}`}>Back to {vault.name}</Link>
      </div>
    );
  }

  const crumbs = head ? folderPath(tree, head.folderId) : [];
  const words = wordCount(editor.body);

  return (
    <div className="note-layout">
      <main className="doc" aria-label="Note">
        <div className="doc-bar">
          <nav aria-label="Breadcrumb" className="crumbs">
            <Link to={`/v/${vault.id}`} className="crumb">
              {vault.name}
            </Link>
            {crumbs.map((f) => (
              <span key={f.id} className="crumb-part">
                <span aria-hidden="true">/</span>
                <span className="crumb">{f.name}</span>
              </span>
            ))}
            <span aria-hidden="true">/</span>
            <input
              ref={titleRef}
              className="crumb-title"
              aria-label="Note title"
              value={title}
              size={Math.max(8, Math.min(48, title.length + 1))}
              maxLength={200}
              spellCheck={prefs.spellcheck()}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => void commitTitle()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  (mode === 'edit' ? textRef.current : titleRef.current)?.focus();
                  if (mode !== 'edit') titleRef.current?.blur();
                } else if (e.key === 'Escape' && head) {
                  setTitle(head.title);
                  window.setTimeout(() => titleRef.current?.blur(), 0);
                }
              }}
              disabled={!head || head.broken}
              readOnly={state.locking}
            />
          </nav>
          <span className={`save-status is-${editor.save}`} role="status" aria-live="polite">
            {editor.status === 'ready' && editor.save === 'idle' ? 'Saved' : SAVE_LABEL[editor.save]}
          </span>
          <div role="group" aria-label="Editor mode" className="segmented">
            <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} title="Edit (Ctrl+E)">
              Edit
            </button>
            <button type="button" aria-pressed={mode === 'view'} onClick={() => setMode('view')} title="View (Ctrl+E)">
              View
            </button>
          </div>
        </div>

        {titleError && (
          <p className="doc-alert" role="alert">
            {titleError}
          </p>
        )}
        {editor.save === 'conflict' && (
          <div className="doc-alert is-conflict" role="alert">
            <span>This note was changed somewhere else after you opened it. Your latest edits are not saved.</span>
            <span className="doc-alert-actions">
              <button type="button" className="btn btn-sm" onClick={editor.reload}>
                Reload theirs
              </button>
              <button type="button" className="btn btn-sm" onClick={editor.overwrite}>
                Keep mine
              </button>
            </span>
          </div>
        )}
        {editor.save === 'error' && editor.saveError && (
          <div className="doc-alert" role="alert">
            <span>Couldn’t save: {editor.saveError}</span>
            <span className="doc-alert-actions">
              <button type="button" className="btn btn-sm" onClick={() => editor.setBody(editor.body)}>
                Try again
              </button>
            </span>
          </div>
        )}

        {editor.status === 'loading' ? (
          <div className="doc-loading">
            <Spinner label="Decrypting note" /> Decrypting…
          </div>
        ) : mode === 'edit' ? (
          <textarea
            ref={textRef}
            className="editor"
            aria-label={`Markdown source of ${head?.title ?? 'note'}`}
            value={editor.body}
            onChange={(e) => editor.setBody(e.target.value)}
            readOnly={state.locking}
            spellCheck={prefs.spellcheck()}
            placeholder={'# Heading\n\nWrite in Markdown. Link notes with [[Note title]].'}
          />
        ) : editor.body.trim() === '' ? (
          <div className="doc-empty">
            <p>This note is empty.</p>
            <button type="button" className="btn btn-sm" onClick={() => setMode('edit')}>
              Start writing
            </button>
          </div>
        ) : (
          // Sanitised by DOMPurify in renderMarkdown.
          <article className="md" onClick={onArticleClick} dangerouslySetInnerHTML={{ __html: html }} />
        )}
      </main>

      <aside className="ctx" aria-label="Note context">
        {graph && head && (
          <section className="ctx-section">
            <h2 className="ctx-title">Local map</h2>
            <LocalMap graph={graph} noteId={noteId} vaultName={vault.name} vaultColor={vault.color} level={vaultStats(vault, tree).level} />
          </section>
        )}
        <section className="ctx-section">
          <h2 className="ctx-title">
            Backlinks{state.bodiesReady[vault.id] ? ` · ${backlinks.length}` : ''}
          </h2>
          {!state.bodiesReady[vault.id] ? (
            <p className="ctx-empty">Looking for notes that link here…</p>
          ) : backlinks.length === 0 ? (
            <p className="ctx-empty">No notes link here yet. Link to this note with [[{head?.title}]].</p>
          ) : (
            backlinks.map((n) => (
              <Link key={n.id} to={`/v/${vault.id}/n/${n.id}`} className="item item-sm">
                {n.title}
              </Link>
            ))
          )}
        </section>
        {head && (
          <section className="ctx-section">
            <h2 className="ctx-title">Properties</h2>
            <dl className="props">
              <dt>Edited</dt>
              <dd title={head.updatedAt}>{relativeTime(head.updatedAt)}</dd>
              <dt>Created</dt>
              <dd>{formatDate(head.createdAt)}</dd>
              <dt>Length</dt>
              <dd>
                {words} {words === 1 ? 'word' : 'words'}
              </dd>
              <dt>Folder</dt>
              <dd>{crumbs.length ? crumbs.map((c) => c.name).join(' / ') : 'Vault root'}</dd>
            </dl>
          </section>
        )}
      </aside>
    </div>
  );
}
