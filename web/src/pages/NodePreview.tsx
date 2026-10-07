import { useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { uniqueTitle } from '../components/VaultTree';
import { describeError, relativeTime } from '../lib/util';
import { indexNoteOf } from '../lib/indexNote';
import { titleIndex } from '../lib/titles';
import { incomingLinks } from '../map/graph';
import type { MapSelection } from '../map/ConceptMap';
import { useVaultGraph } from '../map/useVaultGraphs';
import { renderMarkdown } from '../markdown/render';
import { followNoteLink } from './NotePane';
import { folderPath, useAppState, useStore } from '../state/StoreContext';

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? '' : 's'}`;
const href = (vaultId: string, noteId: string) => `/v/${vaultId}/n/${noteId}`;

function Markdown({ body, ready, vaultId }: { body: string | undefined; ready: boolean; vaultId: string }) {
  const state = useAppState();
  const navigate = useNavigate();
  const titles = useMemo(() => titleIndex(state.trees[vaultId]), [state.trees, vaultId]);
  const html = useMemo(
    () =>
      body
        ? renderMarkdown(body, {
            resolveWikiLink: (t) => {
              const id = titles.get(t.trim().toLowerCase());
              return id ? href(vaultId, id) : null;
            },
          })
        : '',
    [body, titles, vaultId],
  );
  if (body === undefined) return <p className="preview-hint">{ready ? 'No text available.' : 'Decrypting…'}</p>;
  if (!body.trim()) return <p className="preview-hint">This note is empty.</p>;
  // Sanitised by DOMPurify in renderMarkdown, as in NotePane.
  const onClick = (e: MouseEvent<HTMLElement>) => {
    // Task boxes are read-only here; they toggle on the note page.
    if (e.target instanceof HTMLInputElement && e.target.classList.contains('task-checkbox')) {
      e.preventDefault();
      return;
    }
    followNoteLink(e, navigate);
  };
  return <article className="md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** What the Home column shows for a node picked on the map. */
export function NodePreview({ selection, onZoom }: { selection: MapSelection; onZoom: (s: MapSelection) => void }) {
  const state = useAppState();
  const store = useStore();
  const navigate = useNavigate();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { vaultId } = selection;
  const vault = state.vaults[vaultId];
  const tree = state.trees[vaultId];
  const graph = useVaultGraph(state, vaultId);
  const ready = !!state.bodiesReady[vaultId];
  const key = selection.kind === 'hub' ? `hub:${vaultId}` : selection.id;
  useEffect(() => setError(null), [key]);
  if (!vault || !tree) return null;

  /**
   * Creates a note and opens it. `fresh` selects the title (a new "Untitled" note); an Index opens
   * in edit mode with the body focused, so the first keystroke can't rename it away from "Index".
   */
  const run = async (job: () => Promise<{ id: string }>, navState: { fresh: true } | { mode: 'edit' }) => {
    setError(null);
    setBusy(true);
    try {
      const n = await job();
      navigate(href(vaultId, n.id), { state: navState });
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };


  if (selection.kind === 'note') {
    const n = tree.notes[selection.id];
    if (!n) return null;
    const crumbs = [vault.name, ...folderPath(tree, n.folderId).map((f) => f.name)].join(' / ');
    const backlinks = graph && ready ? incomingLinks(graph, n.id) : [];
    return (
      <div className="preview" key={key}>
        <header className="preview-head">
          <h2 className="preview-title">{n.title}</h2>
          <p className="preview-meta">
            {crumbs} · edited {relativeTime(n.updatedAt)}
          </p>
        </header>
        <div className="preview-scroll">
          <Markdown body={state.bodies[n.id]} ready={ready} vaultId={vaultId} />
          <section className="preview-backlinks" aria-label="Backlinks">
            <h3 className="results-sub">Backlinks{ready ? ` · ${backlinks.length}` : ''}</h3>
            {!ready ? (
              <p className="preview-hint">Links appear once note text is decrypted.</p>
            ) : backlinks.length === 0 ? (
              <p className="preview-hint">No other note links here.</p>
            ) : (
              <ul className="res-list">
                {backlinks.map((b) => (
                  <li key={b.id}>
                    <Link className="res" to={href(vaultId, b.id)}>
                      <span className="res-title">{b.title}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="preview-actions">
          <Link className="btn btn-primary btn-sm" to={href(vaultId, n.id)}>
            Open note
          </Link>
          <Link className="btn btn-sm" to={href(vaultId, n.id)} state={{ mode: 'edit' }}>
            Edit
          </Link>
        </div>
      </div>
    );
  }

  const folderId = selection.kind === 'folder' ? selection.id : null;
  const f = folderId ? tree.folders[folderId] : null;
  if (folderId && !f) return null;
  const name = f ? f.name : vault.name;
  const crumbs = [vault.name, ...folderPath(tree, folderId).map((x) => x.name)].join(' / ');
  const index = indexNoteOf(tree, folderId);
  const notes = Object.values(tree.notes)
    .filter((n) => !n.broken && n.folderId === folderId && n.id !== index?.id)
    .sort((a, b) => a.title.localeCompare(b.title) || (a.id < b.id ? -1 : 1));
  const subfolders = Object.values(tree.folders).filter((x) => !x.broken && x.parentId === folderId).length;

  return (
    <div className="preview" key={key}>
      <header className="preview-head">
        <h2 className="preview-title">{name}</h2>
        <p className="preview-meta">
          {folderId ? crumbs : 'Vault'} · {plural(notes.length, 'note')} · {plural(subfolders, 'subfolder')}
        </p>
      </header>
      <div className="preview-scroll">
        {index ? (
          <Markdown body={state.bodies[index.id]} ready={ready} vaultId={vaultId} />
        ) : (
          <p className="preview-hint">
            <button
              type="button"
              className="linkish"
              disabled={busy}
              onClick={() => void run(() => store.addDescription(vaultId, folderId), { mode: 'edit' })}
            >
              Add description
            </button>
          </p>
        )}
        {notes.length > 0 && (
          <section aria-label="Notes in this folder">
            <h3 className="results-sub">Notes</h3>
            <ul className="res-list preview-notes">
              {notes.map((n) => (
                <li key={n.id}>
                  <Link className="res" to={href(vaultId, n.id)}>
                    <span className="res-title">{n.title}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <div className="preview-actions">
        {index && (
          <Link className="btn btn-primary btn-sm" to={href(vaultId, index.id)}>
            Open Index
          </Link>
        )}
        <button
          type="button"
          className="btn btn-sm"
          disabled={busy}
          onClick={() => void run(() => store.createNote(vaultId, folderId, uniqueTitle(tree)), { fresh: true })}
        >
          New note here
        </button>
        <button type="button" className="btn btn-sm" onClick={() => onZoom(selection)}>
          Zoom to folder
        </button>
      </div>
    </div>
  );
}
