import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { inkLevelLabel, VaultIcon } from '../brand/VaultIcon';
import { PromptDialog } from '../components/Dialog';
import { FolderIcon, PlusIcon } from '../components/Icons';
import { uniqueTitle } from '../components/VaultTree';
import { indexNoteOf } from '../lib/indexNote';
import { describeError, relativeTime } from '../lib/util';
import { folderPath, useAppState, useStore, vaultStats } from '../state/StoreContext';
import { NotePane } from './NotePane';

export function VaultPage() {
  const { vaultId = '', noteId } = useParams();
  const state = useAppState();
  const vault = state.vaults[vaultId];

  if (!vault) {
    if (state.vaultsStatus !== 'ready') {
      return <div className="doc-loading">Decrypting vaults…</div>;
    }
    return (
      <div className="doc-empty">
        <p>This vault doesn’t exist, or it isn’t yours.</p>
        <Link to="/">Go home</Link>
      </div>
    );
  }
  if (vault.broken) {
    return (
      <div className="doc-empty">
        <p>This vault couldn’t be decrypted with your keys.</p>
        <Link to="/">Go home</Link>
      </div>
    );
  }
  if (noteId) return <NotePane key={noteId} vault={vault} noteId={noteId} />;
  return <VaultOverview vaultId={vaultId} />;
}

function VaultOverview({ vaultId }: { vaultId: string }) {
  const state = useAppState();
  const store = useStore();
  const navigate = useNavigate();
  const vault = state.vaults[vaultId];
  const tree = state.trees[vaultId];
  const [folderOpen, setFolderOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const stats = vaultStats(vault, tree);

  const notes = useMemo(
    () => Object.values(tree?.notes ?? {}).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [tree],
  );
  const folderCount = Object.keys(tree?.folders ?? {}).length;

  const newNote = async () => {
    setError(null);
    try {
      const head = await store.createNote(vaultId, null, uniqueTitle(tree));
      navigate(`/v/${vaultId}/n/${head.id}`, { state: { fresh: true } });
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <div className="vault-page">
      <header className="vault-head">
        <div className="vault-title-row">
          <VaultIcon color={vault.color} level={stats.level} size={22} />
          <h1 className="vault-title">{vault.name}</h1>
        </div>
        <p className="vault-sub">
          {stats.noteCount} {stats.noteCount === 1 ? 'note' : 'notes'} · {folderCount}{' '}
          {folderCount === 1 ? 'folder' : 'folders'} · {inkLevelLabel(stats.level)}
        </p>
        <div className="vault-actions-row">
          <button type="button" className="btn btn-primary btn-sm" onClick={newNote}>
            <PlusIcon size={12} strokeWidth={2.4} />
            New note
          </button>
          <button type="button" className="btn btn-sm" onClick={() => setFolderOpen(true)}>
            <FolderIcon size={13} />
            New folder
          </button>
        </div>
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </header>

      {!tree || (tree.status === 'loading' && notes.length === 0) ? (
        <p className="empty">Decrypting…</p>
      ) : notes.length === 0 ? (
        <div className="empty">
          <p>This vault is empty. Create a note to start writing, or a folder to organise what comes next.</p>
        </div>
      ) : (
        <section aria-label="Notes in this vault">
          <h2 className="results-title">Recently edited</h2>
          <ul className="res-list">
            {notes.slice(0, 50).map((n) => {
              const path = folderPath(tree, n.folderId)
                .map((f) => f.name)
                .join('/');
              return (
                <li key={n.id}>
                  <Link className="res" to={`/v/${vaultId}/n/${n.id}`}>
                    <span className="res-title">{path ? `${path} / ${n.title}` : n.title}</span>
                    <span className="res-meta">{relativeTime(n.updatedAt)}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      <PromptDialog
        open={folderOpen}
        title="New folder"
        label="Folder name"
        submitLabel="Create folder"
        onClose={() => setFolderOpen(false)}
        onSubmit={async (name) => {
          try {
            const f = await store.createFolder(vaultId, null, name);
            const created = store.getState().trees[vaultId];
            const index = created && indexNoteOf(created, f.id);
            if (index) navigate(`/v/${vaultId}/n/${index.id}`, { state: { mode: 'edit' } });
          } catch (e) {
            throw new Error(describeError(e));
          }
        }}
      />
    </div>
  );
}
