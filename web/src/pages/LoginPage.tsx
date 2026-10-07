import { useEffect, useRef, useState, type FormEvent } from 'react';
import { flushSync } from 'react-dom';
import { Link } from 'react-router-dom';
import { InkFill } from '../brand/InkFill';
import { prefersReducedMotion, setWipeOrigin, withViewTransition } from '../motion';
import { isApiError } from '../api/client';
import { FormError, PasswordField, TextField } from '../components/Fields';
import { UnlockIcon } from '../components/Icons';
import { isCryptoError } from 'inked-core';
import { describeError } from '../lib/util';
import { useAppState, useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

const MAX_TRIES = 5;
/** Lets the drop finish filling before the swap; mirrors --dur-2. */
const DROP_DONE_MS = 140;

export function LoginPage() {
  const store = useStore();
  const state = useAppState();
  // Locking ends the session but remembers the username, so the unlock screen still knows who it is for.
  const known = state.lastUsername || (state.phase === 'locked' ? state.user?.username : null) || null;
  const [username, setUsername] = useState(known ?? state.lastUsername);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [unlocked, setUnlocked] = useState(false);
  const [nudge, setNudge] = useState(false);
  const [failures, setFailures] = useState(0);
  const [waitUntil, setWaitUntil] = useState(0);
  const [now, setNow] = useState(Date.now());
  const pwRef = useRef<HTMLInputElement>(null);
  const userRef = useRef<HTMLInputElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  /** The swap waiting for the drop to fill. Cancelled by a new submit, a recovery or unmount. */
  const swapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelSwap = () => {
    if (swapTimer.current === null) return;
    clearTimeout(swapTimer.current);
    swapTimer.current = null;
  };

  // The store is already unlocked when it notifies; only the screen swap is animated, as an ink wipe.
  useEffect(() => {
    // If the session ended before the swap landed, the unlock is moot: make the form usable again.
    const recover = () => {
      cancelSwap();
      if (store.getState().phase === 'unlocked') return;
      setBusy(false);
      setUnlocked(false);
    };
    const hook = (notify: () => void) => {
      const swap = () => {
        swapTimer.current = null;
        // The hold was already released (the session ended mid-drop): nothing to wipe to.
        if (store.getState().phase !== 'unlocked') {
          notify();
          recover();
          return;
        }
        const root = document.documentElement;
        root.classList.add('is-unlocking');
        const t = withViewTransition(() => {
          flushSync(notify);
          recover();
        });
        const clear = () => root.classList.remove('is-unlocking');
        if (t?.finished) void t.finished.then(clear, clear);
        else clear();
      };
      setUnlocked(true);
      cancelSwap();
      if (prefersReducedMotion()) swap();
      else swapTimer.current = setTimeout(swap, DROP_DONE_MS);
    };
    store.unlockTransition = hook;
    return () => {
      cancelSwap();
      if (store.unlockTransition === hook) store.unlockTransition = null;
    };
    // cancelSwap only touches a ref.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [store]);

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
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setWipeOrigin(r.left + r.width / 2, r.top + r.height / 2);
    // A swap left over from an unlock whose session ended must not touch this attempt.
    cancelSwap();
    setUnlocked(false);
    setBusy(true);
    setNudge(false);
    setError(null);
    store.clearNotice();
    try {
      await store.unlock(u, password);
      if (store.getState().phase !== 'unlocked') {
        setBusy(false);
        return;
      }
      setUnlocked(true);
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
        setNudge(true);
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
    // With a live session, end it; otherwise just forget the remembered name.
    if (state.phase === 'locked') await store.signOut();
    else store.forgetUsername();
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
        <div className={nudge ? 'field-nudge nudge' : 'field-nudge'} onAnimationEnd={(e) => {
            if (e.target === e.currentTarget) setNudge(false);
          }}>
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
        </div>
        <button ref={btnRef} type="submit" className="btn btn-primary btn-block" disabled={busy || waitLeft > 0}>
          {busy ? <InkFill done={unlocked} /> : <UnlockIcon />}
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
