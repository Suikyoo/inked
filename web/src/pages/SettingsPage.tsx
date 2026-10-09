import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router-dom';
import { api, isApiError } from '../api/client';
import type { InviteDTO } from 'inked-core';
import { VaultIcon } from '../brand/VaultIcon';
import { ConfirmDialog } from '../components/Dialog';
import { ProgressBar } from '../components/ProgressBar';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { CheckIcon, CopyIcon } from '../components/Icons';
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel';
import { isCryptoError } from 'inked-core';
import { AskSettings } from './SettingsAsk';
import { prefs } from '../lib/prefs';
import { copyText, describeError, formatDateTime, MIN_PASSWORD, nextVaultColor, rotationCommitError, VAULT_COLORS } from '../lib/util';
import { useSemantic, useSemanticStore } from '../semantic/SemanticContext';
import { useAppState, useStore, vaultStats } from '../state/StoreContext';
import type { PreparedRecoveryKey, VaultView } from '../state/store';

export function SettingsPage() {
  const state = useAppState();
  const store = useStore();
  const location = useLocation();

  useEffect(() => {
    if (location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
  }, [location.hash]);

  return (
    <div className="settings">
      <h1 className="page-title">Settings</h1>

      <section className="card" aria-labelledby="account-h">
        <h2 id="account-h" className="card-title">
          Account
        </h2>
        <p className="card-text">
          Signed in as <strong>{state.user?.username}</strong>
          {state.user?.isAdmin ? ' (admin)' : ''}.
        </p>
        <div className="row-actions">
          <button type="button" className="btn btn-sm" onClick={() => void store.lock()}>
            Lock now
          </button>
          <button type="button" className="btn btn-sm" onClick={() => void store.signOut()}>
            Sign out
          </button>
        </div>
      </section>

      <Editing />
      <SemanticSearch />
      <AskSettings />
      <ChangePassword />
      <RecoveryKey />
      <Vaults />
      {state.user?.isAdmin && <Invites />}
    </div>
  );
}

function Editing() {
  const [spell, setSpell] = useState(prefs.spellcheck());
  return (
    <section className="card" aria-labelledby="edit-h">
      <h2 id="edit-h" className="card-title">
        Editing
      </h2>
      <label className="check">
        <input
          type="checkbox"
          checked={spell}
          onChange={(e) => {
            prefs.setSpellcheck(e.target.checked);
            setSpell(e.target.checked);
          }}
        />
        <span>Spell-check notes and names</span>
      </label>
      <p className="field-hint">
        Off by default. Some browsers send text to an online service for enhanced spell-check, which would expose note
        content and the names of your notes, folders and vaults.
      </p>
    </section>
  );
}

const toMB = (bytes: number) => Math.round(bytes / 1e6);

function SemanticSearch() {
  const sem = useSemantic();
  const store = useSemanticStore();
  const state = useAppState();
  if (!sem.available) return null;
  const mb = sem.downloadBytes === null ? null : toMB(sem.downloadBytes);
  // A failed account save (say, the session locked) leaves the switch showing the account's real state.
  const ignore = () => undefined;
  return (
    <section className="card" aria-labelledby="semantic-h">
      <h2 id="semantic-h" className="card-title">
        Search by meaning
      </h2>
      <label className="check">
        <input type="checkbox" checked={sem.accountOn} onChange={(e) => void store.setEnabled(e.target.checked).catch(ignore)} />
        <span>Search by meaning</span>
      </label>
      <p className="field-hint">Finds notes by what they’re about, not just their words. On for every device you sign in on.</p>
      {sem.accountOn && (
        <p className="field-hint">
          {sem.enabled
            ? sem.phase === 'downloading'
              ? 'Downloading on this browser…'
              : sem.phase === 'ready'
                ? 'Downloaded on this browser.'
                : null
            : 'Not on this browser.'}
          {!sem.enabled && (
            <>
              {' '}
              <button type="button" className="linkish" onClick={() => void store.downloadHere().catch(ignore)}>
                Download{mb !== null ? ` (${mb} MB)` : ''}
              </button>
            </>
          )}
        </p>
      )}
      {sem.phase === 'downloading' && sem.download && (
        <ProgressBar
          value={sem.download.loaded}
          max={sem.download.total}
          label={`Model ${toMB(sem.download.loaded)} / ${toMB(sem.download.total)} MB`}
        />
      )}
      {sem.phase === 'loading' && <p className="field-hint">Preparing the search model…</p>}
      {sem.phase === 'error' && (
        <>
          <FormError>{sem.error}</FormError>
          <div className="row-actions">
            <button type="button" className="btn btn-sm" onClick={() => store.retry()}>
              Retry
            </button>
          </div>
        </>
      )}
      {sem.phase === 'paused' && (
        <p className="field-hint">Search by meaning stopped after a problem. It will try again next time you unlock.</p>
      )}
      {sem.enabled && sem.persistDenied && (
        <p className="field-hint">This browser may clear the model when you close a private window or free up space.</p>
      )}
      {state.vaultOrder.map((id) => {
        const cov = sem.coverage[id];
        const name = state.vaults[id]?.name;
        if (!cov || !name) return null;
        return <ProgressBar key={id} value={cov.done} max={cov.total} label={`${name} · ${cov.done} / ${cov.total} notes`} />;
      })}
    </section>
  );
}

function ChangePassword() {
  const username = useAppState().user?.username ?? '';
  const store = useStore();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setDone(false);
    if (!current) return setError('Enter your current password.');
    if (next.length < MIN_PASSWORD) return setError(`Use at least ${MIN_PASSWORD} characters for the new password.`);
    if (next !== confirm) return setError('The two new passwords don’t match.');
    setBusy(true);
    setError(null);
    try {
      await store.changePassword(current, next);
      setCurrent('');
      setNext('');
      setConfirm('');
      setDone(true);
    } catch (err) {
      if (isCryptoError(err, 'unwrap') || isApiError(err, 403)) setError('Your current password is wrong.');
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="pw-h">
      <h2 id="pw-h" className="card-title">
        Change password
      </h2>
      <p className="card-text">
        Only the key that protects your vault keys is re-wrapped; notes are not re-encrypted. Other signed-in browsers
        are signed out. Your recovery key keeps working.
      </p>
      <form className="form-narrow" onSubmit={submit} noValidate>
        <input type="text" name="username" autoComplete="username" value={username} hidden readOnly />
        <PasswordField label="Current password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={busy} />
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters.`}
          disabled={busy}
        />
        <PasswordField label="Confirm new password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={busy} />
        <div className="row-actions">
          <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
            {busy && <Spinner />}
            {busy ? 'Changing…' : 'Change password'}
          </button>
          {done && (
            <span className="ok-text" role="status">
              <CheckIcon size={12} /> Password changed.
            </span>
          )}
        </div>
        <FormError>{error}</FormError>
      </form>
    </section>
  );
}

function RecoveryKey() {
  const username = useAppState().user?.username ?? '';
  const store = useStore();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  /** Shown first; the server only learns about it once the user confirms they saved it. */
  const [prepared, setPrepared] = useState<PreparedRecoveryKey | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!password) return setError('Enter your password.');
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      setPrepared(await store.prepareRecoveryKeyRotation(password));
      setPassword('');
    } catch (err) {
      if (isCryptoError(err, 'unwrap')) setError('That password isn’t right.');
      else setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    if (!prepared) return;
    setBusy(true);
    setError(null);
    try {
      await store.commitRecoveryKeyRotation(prepared);
      setDone(true);
    } catch (err) {
      // The user has already saved the new key; the message says which key(s) to keep.
      setError(rotationCommitError(err));
    } finally {
      setPrepared(null);
      setBusy(false);
    }
  };

  return (
    <section className="card" id="recovery-key" aria-labelledby="rk-h">
      <h2 id="rk-h" className="card-title">
        Recovery key
      </h2>
      {prepared ? (
        <>
          <p className="card-text">
            This is your new recovery key. It is shown once. Your old key keeps working until you confirm you saved this one.
          </p>
          <div className="rk-settings">
            <RecoveryKeyPanel recoveryKey={prepared.text} doneLabel="Replace my recovery key" busy={busy} onDone={() => void commit()} />
          </div>
        </>
      ) : (
        <>
          {done && (
            <p className="ok-text" role="status">
              <CheckIcon size={12} /> Recovery key replaced. The old key no longer works.
            </p>
          )}
          <p className="card-text">Lost it, or used it to reset your password? Make a new one. You save it first; the old key stops working once you confirm.</p>
          <form className="form-narrow" onSubmit={submit} noValidate>
            <input type="text" name="username" autoComplete="username" value={username} hidden readOnly />
            <PasswordField
              label="Password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={busy}
            />
            <div className="row-actions">
              <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
                {busy && <Spinner />}
                {busy ? 'Making a new key…' : 'Make a new recovery key'}
              </button>
            </div>
            <FormError>{error}</FormError>
          </form>
        </>
      )}
    </section>
  );
}

function ColorPicker({ value, onChange, label }: { value: string; onChange: (c: string) => void; label: string }) {
  const custom = !VAULT_COLORS.some((c) => c.toLowerCase() === value.toLowerCase());
  return (
    <div className="swatches" role="radiogroup" aria-label={label}>
      {VAULT_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={c.toLowerCase() === value.toLowerCase()}
          aria-label={c}
          className="swatch"
          style={{ background: c }}
          onClick={() => onChange(c)}
        />
      ))}
      <label className={custom ? 'swatch swatch-custom is-on' : 'swatch swatch-custom'} title="Custom colour">
        <span className="sr-only">Custom colour</span>
        <input type="color" value={value} onChange={(e) => onChange(e.target.value.toUpperCase())} />
      </label>
    </div>
  );
}

function Vaults() {
  const state = useAppState();
  const store = useStore();
  const vaults = state.vaultOrder.map((id) => state.vaults[id]).filter(Boolean);
  const [name, setName] = useState('');
  const [color, setColor] = useState(() => nextVaultColor(vaults.map((v) => v.color)));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<VaultView | null>(null);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError('Give the vault a name.');
    setBusy(true);
    setError(null);
    try {
      await store.createVault(name.trim(), color);
      setName('');
      setColor(nextVaultColor([...vaults.map((v) => v.color), color]));
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" id="vaults" aria-labelledby="vaults-h">
      <h2 id="vaults-h" className="card-title">
        Vaults
      </h2>
      <p className="card-text">Each vault has its own key. Names and colours are encrypted too.</p>
      {vaults.length === 0 ? (
        <p className="empty">No vaults yet.</p>
      ) : (
        <ul className="vault-settings">
          {vaults.map((v) => (
            <VaultSettingsRow key={v.id} vault={v} onDelete={() => setToDelete(v)} />
          ))}
        </ul>
      )}

      <form className="vault-new" onSubmit={create} noValidate>
        <TextField
          label="New vault"
          placeholder="Vault name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          spellCheck={prefs.spellcheck()}
          disabled={busy}
        />
        <ColorPicker value={color} onChange={setColor} label="New vault colour" />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy}>
          {busy ? 'Creating…' : 'Create vault'}
        </button>
      </form>
      <FormError>{error}</FormError>

      <ConfirmDialog
        open={!!toDelete}
        title="Delete vault?"
        message={
          toDelete && (
            <p>
              “{toDelete.name}” and all {vaultStats(toDelete, state.trees[toDelete.id]).noteCount} notes in it will be
              deleted for good. This can’t be undone.
            </p>
          )
        }
        confirmLabel="Delete vault"
        onClose={() => setToDelete(null)}
        onConfirm={async () => {
          if (!toDelete) return;
          try {
            await store.deleteVault(toDelete.id);
          } catch (e) {
            throw new Error(describeError(e));
          }
        }}
      />
    </section>
  );
}

function VaultSettingsRow({ vault, onDelete }: { vault: VaultView; onDelete: () => void }) {
  const state = useAppState();
  const store = useStore();
  const [name, setName] = useState(vault.name);
  const [color, setColor] = useState(vault.color);
  const [status, setStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [error, setError] = useState<string | null>(null);
  const stats = vaultStats(vault, state.trees[vault.id]);
  const dirty = name.trim() !== vault.name || color.toLowerCase() !== vault.color.toLowerCase();

  useEffect(() => {
    setName(vault.name);
    setColor(vault.color);
  }, [vault.name, vault.color]);

  const save = async (e?: FormEvent) => {
    e?.preventDefault();
    if (!name.trim()) return setError('A vault needs a name.');
    setStatus('saving');
    setError(null);
    try {
      await store.updateVault(vault.id, { name: name.trim(), color });
      setStatus('saved');
    } catch (err) {
      setError(describeError(err));
      setStatus('idle');
    }
  };

  if (vault.broken) {
    return (
      <li className="vault-set-row">
        <div className="vault-set-main">
          <VaultIcon color={vault.color} level={0} size={16} />
          <span className="is-broken">Unreadable vault</span>
        </div>
        <button type="button" className="btn btn-sm btn-danger-quiet" onClick={onDelete}>
          Delete
        </button>
      </li>
    );
  }

  return (
    <li className="vault-set-row">
      <form className="vault-set-main" onSubmit={save}>
        <VaultIcon color={color} level={stats.level} size={16} />
        <label className="sr-only" htmlFor={`vn-${vault.id}`}>
          Name of vault {vault.name}
        </label>
        <input
          id={`vn-${vault.id}`}
          className="input input-sm vault-name-input"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            setStatus('idle');
          }}
          maxLength={80}
          spellCheck={prefs.spellcheck()}
        />
        <ColorPicker
          value={color}
          onChange={(c) => {
            setColor(c);
            setStatus('idle');
          }}
          label={`Colour of vault ${vault.name}`}
        />
        <button type="submit" className="btn btn-sm" disabled={!dirty || status === 'saving'}>
          {status === 'saving' ? 'Saving…' : status === 'saved' && !dirty ? 'Saved' : 'Save'}
        </button>
      </form>
      <button type="button" className="btn btn-sm btn-danger-quiet" onClick={onDelete}>
        Delete
      </button>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </li>
  );
}

const EXPIRY_OPTIONS = [
  { hours: 24, label: '24 hours' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '7 days' },
];

function inviteStatus(inv: InviteDTO): { label: string; active: boolean } {
  if (inv.usedBy || inv.usedAt) return { label: `Used by ${inv.usedBy ?? 'someone'}${inv.usedAt ? ' · ' + formatDateTime(inv.usedAt) : ''}`, active: false };
  if (Date.parse(inv.expiresAt) < Date.now()) return { label: 'Expired', active: false };
  return { label: `Open until ${formatDateTime(inv.expiresAt)}`, active: true };
}

function Invites() {
  const [invites, setInvites] = useState<InviteDTO[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [hours, setHours] = useState(72);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<{ url: string; expiresAt: string } | null>(null);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    try {
      const { invites } = await api.listInvites();
      setInvites(invites.slice().sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
      setLoadError(null);
    } catch (e) {
      setLoadError(describeError(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const { token, expiresAt } = await api.createInvite(hours);
      setCreated({ url: `${window.location.origin}/join/${token}`, expiresAt });
      void load();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (id: string) => {
    setError(null);
    try {
      await api.revokeInvite(id);
      void load();
    } catch (e) {
      setError(describeError(e));
    }
  };

  return (
    <section className="card" aria-labelledby="inv-h">
      <h2 id="inv-h" className="card-title">
        Invites
      </h2>
      <p className="card-text">An invite link creates one account. Anyone with the link can use it until it expires.</p>
      <div className="row-actions">
        <label className="field-label" htmlFor="inv-exp">
          Expires after
        </label>
        <select id="inv-exp" className="input input-sm select-sm" value={hours} onChange={(e) => setHours(Number(e.target.value))}>
          {EXPIRY_OPTIONS.map((o) => (
            <option key={o.hours} value={o.hours}>
              {o.label}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-primary btn-sm" onClick={create} disabled={busy}>
          {busy ? 'Creating…' : 'Create invite link'}
        </button>
      </div>
      {created && (
        <div className="invite-created">
          <label className="field-label" htmlFor="inv-url">
            Send this link to the person you’re inviting. It is shown only now.
          </label>
          <div className="copy-row">
            <input id="inv-url" className="input input-sm mono" readOnly value={created.url} onFocus={(e) => e.target.select()} />
            <button
              type="button"
              className="btn btn-sm"
              onClick={async () => setCopied(await copyText(created.url))}
            >
              {copied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <p className="field-hint">Works once. Expires {formatDateTime(created.expiresAt)}.</p>
        </div>
      )}
      <FormError>{error}</FormError>

      {loadError ? (
        <p className="form-error">{loadError}</p>
      ) : invites === null ? (
        <p className="empty">Loading invites…</p>
      ) : invites.length === 0 ? (
        <p className="empty">No invites yet.</p>
      ) : (
        <ul className="invite-list">
          {invites.map((inv) => {
            const st = inviteStatus(inv);
            return (
              <li key={inv.id} className="invite-row">
                <span className="invite-when">Created {formatDateTime(inv.createdAt)}</span>
                <span className={st.active ? 'invite-status is-active' : 'invite-status'}>{st.label}</span>
                {st.active && (
                  <button type="button" className="btn btn-sm btn-danger-quiet" onClick={() => void revoke(inv.id)}>
                    Revoke
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
