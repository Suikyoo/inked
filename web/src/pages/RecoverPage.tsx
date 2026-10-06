import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { isApiError } from '../api/client';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel';
import { isCryptoError } from '../crypto';
import { describeError, MIN_PASSWORD, ROTATION_NOT_SAVED, rotationCommitError } from '../lib/util';
import type { PreparedRecoveryKey } from '../state/store';
import { useAppState, useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

type Step = 'form' | 'working' | 'rotating' | 'replacing' | 'rotateFailed';

/**
 * Resets the password with the recovery key, then replaces that recovery key: once used it may
 * have been exposed. The new key is shown first and only sent to the server once the user confirms
 * they saved it, so a key nobody saw can never become the only one that works.
 */
export function RecoverPage() {
  const store = useStore();
  const state = useAppState();
  const navigate = useNavigate();
  const keyId = useId();
  const [step, setStep] = useState<Step>('form');
  const [username, setUsername] = useState(state.lastUsername);
  const [recoveryKey, setRecoveryKey] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [newKey, setNewKey] = useState<PreparedRecoveryKey | null>(null);
  const [committing, setCommitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(t);
  }, [waitUntil]);
  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  // Once the reset has started we stay here until the new recovery key is acknowledged.
  if (step === 'form' && state.phase === 'setup') return <Navigate to="/setup" replace />;
  if (step === 'form' && state.phase === 'unlocked') return <Navigate to="/" replace />;

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
    setStep('working');
    setError(null);
    try {
      await store.recover(u, recoveryKey, password);
    } catch (err) {
      setStep('form');
      if (isCryptoError(err, 'format')) setError(err.message);
      else if (isCryptoError(err, 'unwrap')) setError('That recovery key doesn’t open this account.');
      else if (isApiError(err, 401)) setError('That username and recovery key don’t match.');
      else if (isApiError(err, 429)) {
        setWaitUntil(Date.now() + (err.retryAfter ?? 60) * 1000);
        setNow(Date.now());
      } else setError(describeError(err));
      return;
    }
    setRecoveryKey('');
    setStep('rotating');
    try {
      setNewKey(await store.prepareRecoveryKeyRotation(password));
      setStep('replacing');
    } catch {
      // Nothing was sent, so the old key is untouched.
      setError(ROTATION_NOT_SAVED);
      setStep('rotateFailed');
    } finally {
      setPassword('');
      setConfirm('');
    }
  };

  const commit = async () => {
    if (!newKey) return;
    setCommitting(true);
    setError(null);
    try {
      await store.commitRecoveryKeyRotation(newKey);
      setNewKey(null);
      navigate('/', { replace: true });
    } catch (err) {
      setNewKey(null);
      setError(rotationCommitError(err));
      setStep('rotateFailed');
    } finally {
      setCommitting(false);
    }
  };

  if (step === 'replacing' && newKey) {
    return (
      <AuthLayout
        wide
        title="Save your new recovery key"
        lead="Your password is reset. The key you just used may have been exposed, so it is replaced by this new one once you confirm you saved it. It is shown once."
      >
        <RecoveryKeyPanel
          recoveryKey={newKey.text}
          doneLabel="Replace my recovery key"
          busy={committing}
          onDone={() => void commit()}
        />
      </AuthLayout>
    );
  }

  if (step === 'rotateFailed') {
    return (
      <AuthLayout
        title="Password reset"
        lead="Your new password works, but replacing your recovery key didn’t go through as planned. Make a new one in Settings."
      >
        <div className="auth-form">
          <FormError>{error}</FormError>
          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => navigate('/settings#recovery-key', { replace: true })}
          >
            Make a new recovery key
          </button>
        </div>
      </AuthLayout>
    );
  }

  const busy = step !== 'form';

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
          {step === 'rotating' ? 'Making a new recovery key…' : busy ? 'Recovering…' : 'Set new password'}
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
