import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../api/client';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { isCryptoError } from '../crypto';
import { describeError, MIN_PASSWORD } from '../lib/util';
import { useAppState, useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

export function RecoverPage() {
  const store = useStore();
  const state = useAppState();
  const keyId = useId();
  const [username, setUsername] = useState(state.lastUsername);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [waitUntil]);
  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (!u || !recoveryKey.trim()) {
      setError('Enter your username and recovery key.');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your new password.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await store.recover(u, recoveryKey, password);
      // Route guard takes over once unlocked.
    } catch (err) {
      setBusy(false);
      if (isCryptoError(err, 'format')) setError(err.message);
      else if (isCryptoError(err, 'unwrap')) setError('That recovery key doesn’t open this account.');
      else if (isApiError(err, 401)) setError('That username and recovery key don’t match.');
      else if (isApiError(err, 429)) {
        setWaitUntil(Date.now() + (err.retryAfter ?? 60) * 1000);
        setNow(Date.now());
      } else setError(describeError(err));
    }
  };

  return (
    <AuthLayout
      title="Recover your account"
      lead="Use the recovery key you saved when you created your account to set a new password. Your notes stay as they are."
      footer={<Link to="/login">Back to unlock</Link>}
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        <TextField
          label="Username"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          disabled={busy}
          autoFocus={!username}
        />
        <div className="field">
          <label className="field-label" htmlFor={keyId}>
            Recovery key
          </label>
          <textarea
            id={keyId}
            className="input rk-input"
            rows={3}
            placeholder="inked-rk1-XXXX-XXXX-…"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={recoveryKey}
            onChange={(e) => setRecoveryKey(e.target.value)}
            disabled={busy}
            autoFocus={!!username}
          />
        </div>
        <PasswordField
          label="New password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters.`}
          disabled={busy}
        />
        <PasswordField
          label="Confirm new password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || waitLeft > 0}>
          {busy && <Spinner />}
          {busy ? 'Recovering…' : 'Set new password'}
        </button>
        {waitLeft > 0 ? (
          <p className="form-error" role="status">
            Too many tries. Try again in {waitLeft} s.
          </p>
        ) : (
          <FormError>{error}</FormError>
        )}
      </form>
    </AuthLayout>
  );
}
