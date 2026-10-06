import { useState } from 'react';
import { Link, NavLink, useMatch, useNavigate } from 'react-router-dom';
import { Logo, Wordmark } from '../brand/Logo';
import { inkLevelLabel, VaultIcon } from '../brand/VaultIcon';
import { describeError, nextVaultColor } from '../lib/util';
import { useAppState, useStore, vaultStats } from '../state/StoreContext';
import { PromptDialog } from './Dialog';
import { LockIcon, MapIcon, MoreIcon, PlusIcon, SettingsIcon } from './Icons';
import { Menu } from './Menu';
import { uniqueTitle, VaultTree } from './VaultTree';

export function Sidebar({ id, onLock }: { id: string; onLock: () => void }) {
  const state = useAppState();
  const store = useStore();
  const navigate = useNavigate();
  const vaultMatch = useMatch('/v/:vaultId/*');
  const noteMatch = useMatch('/v/:vaultId/n/:noteId');
  const activeVault = vaultMatch?.params.vaultId ?? null;
  const activeNote = noteMatch?.params.noteId ?? null;
  const [expanded, setExpandedState] = useState<Set<string>>(() => new Set());
  const [newVaultOpen, setNewVaultOpen] = useState(false);
  const [folderSignal, setFolderSignal] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const setExpanded = (fn: (s: Set<string>) => Set<string>) => setExpandedState(fn);

  const vaults = state.vaultOrder.map((vid) => state.vaults[vid]).filter(Boolean);

  return (
    <aside id={id} className="sidebar" aria-label="Sidebar">
      <div className="side-head">
        <Link to="/" className="brand" aria-label="Inked home">
          <Logo size={18} />
          <Wordmark />
        </Link>
        <button type="button" className="ibtn" aria-label="Lock all vaults" title="Lock all vaults" onClick={onLock}>
          <LockIcon />
        </button>
      </div>

      <nav aria-label="Primary" className="side-nav">
        <NavLink to="/" end className="item">
          <MapIcon className="item-icon" />
          Home
        </NavLink>
      </nav>

      <section aria-label="Vaults" className="side-vaults">
        <div className="side-label-row">
          <span className="side-label">Vaults</span>
          <button
            type="button"
            className="ibtn ibtn-xs"
            aria-label="New vault"
            title="New vault"
            onClick={() => setNewVaultOpen(true)}
          >
            <PlusIcon size={12} />
          </button>
        </div>

        {state.vaultsStatus === 'loading' && vaults.length === 0 && <p className="side-empty">Decrypting vaults…</p>}
        {state.vaultsStatus === 'error' && (
          <p className="side-empty">
            Couldn’t load your vaults.{' '}
            <button type="button" className="linkish" onClick={() => void store.loadAll().catch(() => undefined)}>
              Try again
            </button>
          </p>
        )}
        {state.vaultsStatus === 'ready' && vaults.length === 0 && (
          <p className="side-empty">
            No vaults yet.{' '}
            <button type="button" className="linkish" onClick={() => setNewVaultOpen(true)}>
              Create one
            </button>
          </p>
        )}

        {vaults.map((v) => {
          const stats = vaultStats(v, state.trees[v.id]);
          const open = v.id === activeVault;
          const tree = state.trees[v.id];
          return (
            <div key={v.id} className="vault-block">
              <div className={open ? 'vault-row is-open' : 'vault-row'}>
                <Link
                  to={`/v/${v.id}`}
                  className="item vault-link"
                  aria-current={open && !activeNote ? 'page' : undefined}
                  aria-expanded={v.broken ? undefined : open}
                  title={`${v.name} · ${inkLevelLabel(stats.level)}`}
                >
                  <VaultIcon color={v.color} level={stats.level} />
                  <span className={v.broken ? 'vault-name is-broken' : 'vault-name'}>{v.name}</span>
                  <span className="count">{stats.noteCount}</span>
                </Link>
                {open && !v.broken && (
                  <span className="vault-actions">
                    <Menu
                      label={`Actions for vault ${v.name}`}
                      className="ibtn ibtn-sm"
                      items={[
                        {
                          label: 'New note',
                          onSelect: async () => {
                            try {
                              const head = await store.createNote(v.id, null, uniqueTitle(tree));
                              navigate(`/v/${v.id}/n/${head.id}`, { state: { fresh: true } });
                            } catch (e) {
                              setError(describeError(e));
                            }
                          },
                        },
                        { label: 'New folder', onSelect: () => setFolderSignal((n) => n + 1) },
                        { label: 'Vault settings', onSelect: () => navigate('/settings#vaults') },
                      ]}
                    >
                      <MoreIcon size={12} />
                    </Menu>
                  </span>
                )}
              </div>
              {open && !v.broken && (
                <div className="tree-wrap">
                  <VaultTree
                    vault={v}
                    tree={tree}
                    activeNoteId={activeNote}
                    expanded={expanded}
                    setExpanded={setExpanded}
                    newFolderSignal={folderSignal}
                  />
                </div>
              )}
            </div>
          );
        })}
        {error && (
          <p className="tree-error" role="alert">
            {error}
          </p>
        )}
      </section>

      <div className="side-grow" />
      <div className="side-foot">
        <NavLink to="/settings" className="item">
          <SettingsIcon className="item-icon" />
          Settings
        </NavLink>
        <span className="side-meta">
          <LockIcon size={11} strokeWidth={2} />
          Encrypted in your browser
        </span>
      </div>

      <PromptDialog
        open={newVaultOpen}
        title="New vault"
        label="Vault name"
        submitLabel="Create vault"
        onClose={() => setNewVaultOpen(false)}
        onSubmit={async (name) => {
          try {
            const v = await store.createVault(name, nextVaultColor(vaults.map((x) => x.color)));
            navigate(`/v/${v.id}`);
          } catch (e) {
            throw new Error(describeError(e));
          }
        }}
      />
    </aside>
  );
}
