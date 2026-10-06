import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { FormError, PasswordField, Spinner, TextField } from '../components/Fields';
import { RecoveryKeyPanel } from '../components/RecoveryKeyPanel';
import { describeError, MIN_PASSWORD, USERNAME_RE } from '../lib/util';
import { useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';

export type RegisterStep = 'form' | 'working' | 'recovery';

/**
 * Shared by /setup (first admin, asks for the setup token) and /join/:token (invite). After the
 * account exists the recovery key is shown exactly once; it lives only in this component's state.
 */
export function RegisterFlow({
  title,
  lead,
  inviteToken,
  askSetupToken = false,
  step,
  setStep,
}: {
  title: string;
  lead: string;
  inviteToken?: string;
  askSetupToken?: boolean;
  step: RegisterStep;
  setStep: (s: RegisterStep) => void;
}) {
  const store = useStore();
  const navigate = useNavigate();
  const [setupToken, setSetupToken] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [recoveryKey, setRecoveryKey] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const token = setupToken.trim();
    if (askSetupToken && !token) {
      setError('Enter the setup token from the server log.');
      return;
    }
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
      const rk = await store.register({
        username: u,
        password,
        inviteToken,
        setupToken: askSetupToken ? token : undefined,
      });
      setPassword('');
      setConfirm('');
      setSetupToken('');
      setRecoveryKey(rk);
      setStep('recovery');
    } catch (err) {
      setError(describeError(err));
      setStep('form');
    }
  };

  if (step === 'recovery' && recoveryKey) {
    return (
      <AuthLayout
        wide
        title="Save your recovery key"
        lead="If you forget your password, this key is the only way back into your notes. Nobody else can reset it for you, not even the server admin. It is shown once."
      >
        <RecoveryKeyPanel
          recoveryKey={recoveryKey}
          doneLabel="Continue to Inked"
          onDone={() => {
            setRecoveryKey(null);
            navigate('/', { replace: true });
          }}
        />
      </AuthLayout>
    );
  }

  const busy = step === 'working';
  return (
    <AuthLayout title={title} lead={lead}>
      <form className="auth-form" onSubmit={submit} noValidate>
        {askSetupToken && (
          <TextField
            label="Setup token"
            name="setup-token"
            autoComplete="off"
            autoCapitalize="off"
            spellCheck={false}
            value={setupToken}
            onChange={(e) => setSetupToken(e.target.value)}
            hint={
              <>
                Printed in the server log on first start (<code>docker compose logs inked</code>).
              </>
            }
            disabled={busy}
            autoFocus
          />
        )}
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
          autoFocus={!askSetupToken}
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
