import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { isApiError } from '../api/client';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { UnlockIcon } from '../components/Icons';
import { isCryptoError } from '../crypto';
import { describeError } from '../lib/util';
import { useAppState, useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

const MAX_TRIES = 5;

export function LoginPage() {
  const store = useStore();
  const state = useAppState();
  const known = state.phase === 'locked' && state.user ? state.user.username : null;
  const [username, setUsername] = useState(known ?? state.lastUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [failures, setFailures] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const pwRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (known) setUsername(known);
  }, [known]);

  useEffect(() => {
    (username ? pwRef : userRef).current?.focus();
    // Only on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (waitUntil <= Date.now()) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= waitUntil) clearInterval(t);
    }, 250);
    return () => clearInterval(t);
  }, [waitUntil]);

  const waitLeft = Math.max(0, Math.ceil((waitUntil - now) / 1000));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (!u || !password || waitLeft > 0) {
      if (!u) setError('Enter your username.');
      else if (!password) setError('Enter your password.');
      return;
    }
    setBusy(true);
    setError(null);
    store.clearNotice();
    try {
      await store.unlock(u, password);
      setFailures(0);
      // The route guard redirects once the store is unlocked.
    } catch (err) {
      setBusy(false);
      setPassword('');
      pwRef.current?.focus();
      if (isApiError(err, 429)) {
        const secs = err.retryAfter ?? 60;
        setWaitUntil(Date.now() + secs * 1000);
        setNow(Date.now());
        setFailures(0);
        setError(null);
      } else if (isApiError(err, 401)) {
        const n = failures + 1;
        setFailures(n);
        const left = MAX_TRIES - n;
        const what = known ? 'Wrong password.' : 'Wrong username or password.';
        setError(
          left > 0
            ? `${what} ${left} ${left === 1 ? 'try' : 'tries'} left before a 60-second wait.`
            : `${what} The next wrong try starts a 60-second wait.`,
        );
      } else if (isCryptoError(err, 'unwrap')) {
        setError('Signed in, but your keys could not be opened with this password.');
      } else {
        setError(describeError(err));
      }
    }
  };

  const signOutOther = async () => {
    await store.signOut();
    setUsername('');
    setPassword('');
    userRef.current?.focus();
  };

  return (
    <AuthLayout
      lead="Your vaults are locked. Notes stay encrypted on disk until you unlock them."
      footer={
        <>
          Locks again after 15 minutes idle.
          <br />
          <Link to="/recover">Forgot password? Recovery needs your recovery key.</Link>
        </>
      }
    >
      <form className="auth-form" onSubmit={submit} noValidate>
        {state.notice && (
          <p className="notice" role="status">
            {state.notice}
          </p>
        )}
        {known ? (
          <p className="auth-who">
            Unlocking as <strong>{known}</strong>.{' '}
            <button type="button" className="linkish" onClick={signOutOther}>
              Not you?
            </button>
          </p>
        ) : (
          <TextField
            ref={userRef}
            label="Username"
            name="username"
            autoComplete="username"
            autoCapitalize="off"
            spellCheck={false}
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            disabled={busy}
          />
        )}
        {known && <input type="hidden" name="username" autoComplete="username" value={known} readOnly />}
        <PasswordField
          ref={pwRef}
          label="Password"
          name="password"
          autoComplete="current-password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || waitLeft > 0}>
          {busy ? <Spinner /> : <UnlockIcon />}
          {busy ? 'Unlocking…' : 'Unlock'}
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
