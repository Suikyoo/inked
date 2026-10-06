import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { CheckIcon, CopyIcon } from '../components/Icons';
import { copyText, describeError, MIN_PASSWORD, USERNAME_RE } from '../lib/util';
import { useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

export type RegisterStep = 'form' | 'working' | 'recovery';

/**
 * Shared by /setup (first admin) and /join/:token (invite). After the account exists the
 * recovery key is shown exactly once; it lives only in this component's state.
 */
export function RegisterFlow({
  title,
  lead,
  inviteToken,
  step,
  setStep,
}: {
  title: string;
  lead: string;
  inviteToken?: string;
  step: RegisterStep;
  setStep: (s: RegisterStep) => void;
}) {
  const store = useStore();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const u = username.trim().toLowerCase();
    if (!USERNAME_RE.test(u)) {
      setError('Usernames are 3–32 characters: lowercase letters, digits, dot, dash or underscore.');
      return;
    }
    if (password.length < MIN_PASSWORD) {
      setError(`Use at least ${MIN_PASSWORD} characters for your password.`);
      return;
    }
    if (password !== confirm) {
      setError('The two passwords don’t match.');
      return;
    }
    setError(null);
    setStep('working');
    try {
      const rk = await store.register({ username: u, password, inviteToken });
      setPassword('');
      setConfirm('');
      setRecoveryKey(rk);
      setStep('recovery');
    } catch (err) {
      setError(describeError(err));
      setStep('form');
    }
  };

  if (step === 'recovery' && recoveryKey) {
    return <RecoveryKeyPanel recoveryKey={recoveryKey} onDone={() => setRecoveryKey(null)} />;
  }

  const busy = step === 'working';
  return (
    <AuthLayout title={title} lead={lead}>
      <form className="auth-form" onSubmit={submit} noValidate>
        <TextField
          label="Username"
          name="username"
          autoComplete="username"
          autoCapitalize="off"
          spellCheck={false}
          value={username}
          onChange={(e) => setUsername(e.target.value.toLowerCase())}
          hint="3–32 characters: a–z, 0–9, dot, dash, underscore."
          disabled={busy}
          autoFocus
        />
        <PasswordField
          label="Password"
          name="new-password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          hint={`At least ${MIN_PASSWORD} characters. It never leaves this browser.`}
          disabled={busy}
        />
        <PasswordField
          label="Confirm password"
          name="confirm-password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="btn btn-primary btn-block" disabled={busy}>
          {busy && <Spinner />}
          {busy ? 'Creating your keys…' : 'Create account'}
        </button>
        <FormError>{error}</FormError>
      </form>
    </AuthLayout>
  );
}

function RecoveryKeyPanel({ recoveryKey, onDone }: { recoveryKey: string; onDone: () => void }) {
  const navigate = useNavigate();
  const [copied, setCopied] = useState(false);
  const [saved, setSaved] = useState(false);
  const groups = recoveryKey.split('-');
  const prefix = groups.slice(0, 2).join('-') + '-';
  const body = groups.slice(2);

  return (
    <AuthLayout
      wide
      title="Save your recovery key"
      lead="If you forget your password, this key is the only way back into your notes. Nobody else can reset it for you, not even the server admin. It is shown once."
    >
      <div className="rk-panel">
        <p className="rk-key" aria-label="Recovery key">
          <span className="rk-prefix">{prefix}</span>
          {body.map((g, i) => (
            <span key={i} className="rk-group">
              {g}
              {i < body.length - 1 ? '-' : ''}
            </span>
          ))}
        </p>
        <button
          type="button"
          className="btn"
          onClick={async () => {
            setCopied(await copyText(recoveryKey));
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? 'Copied' : 'Copy recovery key'}
        </button>
        <p className="field-hint">Keep it in a password manager or print it. Don’t store it next to your password.</p>
      </div>
      <div className="auth-form">
        <label className="check">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
          <span>I saved my recovery key somewhere safe</span>
        </label>
        <button
          type="button"
          className="btn btn-primary btn-block"
          disabled={!saved}
          onClick={() => {
            onDone();
            navigate('/', { replace: true });
          }}
        >
          Continue to Inked
        </button>
      </div>
    </AuthLayout>
  );
}
