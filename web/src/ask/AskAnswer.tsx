import { answerToNote, llmOrigin, type SearchEntry } from 'inked-core';
import { useMemo, useState, type MouseEvent } from 'react';
import { Link } from 'react-router-dom';
import type { MapSelection } from '../map/ConceptMap';
import { renderUntrustedMarkdown } from '../markdown/render';
import { describeError, copyText } from '../lib/util';
import { useAppState, useStore } from '../state/StoreContext';
import type { AppState } from '../state/store';
import { useAccountSettings } from '../state/AccountSettingsContext';
import { useAsk, useAskStore } from './AskContext';
import type { AskState, AskTurnView } from './askStore';
import { askErrorMessage } from './messages';

/** Notes the map lights for Ask: the sources while an answer streams, then only the cited ones. */
export function askLitIds(state: AskState): Set<string> {
  const t = state.turns[state.turns.length - 1];
  if (!t) return new Set();
  return new Set(t.status === 'retrieving' || t.status === 'streaming' ? t.sources.map((s) => s.noteId) : t.cited);
}

/** Every folder of the given vaults as "vaultId:folderId" ("vaultId:" is the vault root), labelled "Vault / path". */
function folderOptions(state: AppState, vaultIds: string[]): { value: string; label: string }[] {
  const out: { value: string; label: string }[] = [];
  for (const vaultId of vaultIds) {
    const v = state.vaults[vaultId];
    const tree = state.trees[vaultId];
    if (!v || !tree) continue;
    out.push({ value: `${vaultId}:`, label: v.name });
    const pathOf = (id: string): string => {
      const f = tree.folders[id];
      return f ? (f.parentId ? `${pathOf(f.parentId)}/${f.name}` : f.name) : '';
    };
    for (const f of Object.values(tree.folders)) if (!f.broken) out.push({ value: `${vaultId}:${f.id}`, label: `${v.name} / ${pathOf(f.id)}` });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

function SaveAsNote({ turn }: { turn: AskTurnView }) {
  const state = useAppState();
  const store = useStore();
  const vaultKey = [...new Set(turn.sources.map((s) => s.vaultId))].join(',');
  const options = useMemo(() => folderOptions(state, vaultKey.split(',').filter(Boolean)), [state, vaultKey]);
  const first = turn.sources.find((s) => s.noteId === turn.cited[0]) ?? turn.sources[0];
  const firstFolder = first ? state.trees[first.vaultId]?.notes[first.noteId]?.folderId ?? null : null;
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState(first ? `${first.vaultId}:${firstFolder ?? ''}` : options[0]?.value ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!open) {
    return (
      <button type="button" className="btn btn-sm" onClick={() => setOpen(true)} disabled={saved}>
        {saved ? 'Saved' : 'Save as note'}
      </button>
    );
  }
  const save = async () => {
    const [vaultId, folder] = target.split(':');
    const cited = turn.cited.map((id) => turn.sources.find((s) => s.noteId === id)).filter((s): s is NonNullable<typeof s> => !!s);
    const { title, body } = answerToNote(turn.question, turn.answer, cited);
    setBusy(true);
    setError(null);
    try {
      await store.createNote(vaultId, folder || null, title, body);
      setSaved(true);
      setOpen(false);
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <span className="ask-save">
      <label className="sr-only" htmlFor={`ask-folder-${turn.id}`}>
        Folder
      </label>
      <select id={`ask-folder-${turn.id}`} value={target} onChange={(e) => setTarget(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => void save()} disabled={busy}>
        Save
      </button>
      <button type="button" className="btn btn-sm" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="form-error">{error}</span>}
    </span>
  );
}

function Turn({ turn, last, entries, onSelect }: { turn: AskTurnView; last: boolean; entries: readonly SearchEntry[]; onSelect: (s: MapSelection) => void }) {
  const ask = useAskStore();
  const account = useAccountSettings();
  const byTitle = useMemo(() => new Map(turn.sources.map((s) => [s.title.trim().toLowerCase(), s])), [turn.sources]);
  const html = useMemo(
    () =>
      renderUntrustedMarkdown(turn.answer, {
        resolveWikiLink: (title) => {
          const s = byTitle.get(title.trim().toLowerCase());
          return s ? `/v/${s.vaultId}/n/${s.noteId}` : null;
        },
      }),
    [turn.answer, byTitle],
  );
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const a = (e.target as Element).closest('a.wl');
    const m = a?.getAttribute('href')?.match(/^\/v\/([^/]+)\/n\/([^/]+)$/);
    if (!m) return;
    e.preventDefault();
    onSelect({ kind: 'note', vaultId: m[1], id: m[2] });
  };
  const origin = account.settings.llm ? llmOrigin(account.settings.llm.baseUrl) : null;
  const [copied, setCopied] = useState<string | null>(null);
  const copy = async () => {
    let ok = false;
    try {
      ok = await copyText(turn.answer);
    } catch {
      ok = false;
    }
    setCopied(ok ? 'Copied' : 'Couldn’t copy');
    setTimeout(() => setCopied(null), 2000);
  };
  const done = turn.status === 'done' || turn.status === 'stopped';
  return (
    <article className="ask-turn" aria-busy={turn.status === 'retrieving' || turn.status === 'streaming'}>
      <h3 className="ask-q">{turn.question}</h3>
      {turn.status === 'retrieving' && <p className="results-note">Finding sources…</p>}
      {turn.status === 'empty' && <p className="empty">No notes match closely enough.</p>}
      {turn.answer && <div className="ask-a md" onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />}
      {turn.status === 'error' && turn.error === 'setup' && (
        <p className="form-error">
          <Link to="/settings">Set up Ask in Settings</Link>
        </p>
      )}
      {turn.status === 'error' && turn.error && turn.error !== 'setup' && (
        <p className="form-error">
          {askErrorMessage(turn.error, origin)}{' '}
          {last && (
            <button type="button" className="linkish" onClick={() => void ask.retry(entries)}>
              Retry
            </button>
          )}
        </p>
      )}
      {done && turn.answer && (
        <div className="ask-actions">
          <SaveAsNote turn={turn} />
          <button type="button" className="btn btn-sm" onClick={() => void copy()}>
            Copy
          </button>
          {copied && <span className="results-note" role="status">{copied}</span>}
          <span className="results-note">
            {turn.cited.length} {turn.cited.length === 1 ? 'source' : 'sources'} lit on the map
          </span>
        </div>
      )}
      {turn.via === 'text' && turn.status !== 'retrieving' && (
        <p className="results-note">Found by text. Turn on search by meaning for better sources.</p>
      )}
    </article>
  );
}

/** The conversation that replaces Home's results column while asking. */
export function AskAnswer({ entries, onSelect }: { entries: readonly SearchEntry[]; onSelect: (s: MapSelection) => void }) {
  const ask = useAsk();
  const last = ask.turns[ask.turns.length - 1];
  return (
    <div className="ask" aria-live="polite" aria-atomic="false" aria-busy={ask.busy}>
      <h2 className="results-title">{ask.busy ? 'Asking your notes…' : 'Answer'}</h2>
      {ask.turns.map((t) => (
        <Turn key={t.id} turn={t} last={t === last} entries={entries} onSelect={onSelect} />
      ))}
    </div>
  );
}
