import { useEffect, useState } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { api } from '../api/client';
import { Spinner } from '../components/Fields';
import { useAppState, useStore } from '../state/StoreContext';
import { AuthLayout } from './AuthLayout';
import { RegisterFlow, type RegisterStep } from './RegisterFlow';

export function SetupPage() {
  const state = useAppState();
  const [step, setStep] = useState<RegisterStep>('form');
  // Once the flow has started we stay here until the recovery key is acknowledged.
  if (step === 'form' && state.phase !== 'setup') return <Navigate to="/" replace />;
  return (
    <RegisterFlow
      title="Set up Inked"
      lead="Create the first account. It becomes the admin and can invite others."
      askSetupToken
      step={step}
      setStep={setStep}
    />
  );
}

export function JoinPage() {
  const { token = '' } = useParams();
  const state = useAppState();
  const store = useStore();
  const [step, setStep] = useState<RegisterStep>('form');
  const [valid, setValid] = useState<boolean | null>(null);
  const [checkFailed, setCheckFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setValid(null);
    setCheckFailed(false);
    api.checkInvite(token).then(
      (r) => alive && setValid(r.valid),
      () => alive && setCheckFailed(true),
    );
    return () => {
      alive = false;
    };
  }, [token]);

  if (step !== 'form') {
    return (
      <RegisterFlow title="Join Inked" lead="Create your account." inviteToken={token} step={step} setStep={setStep} />
    );
  }
  if (state.phase === 'setup') return <Navigate to="/setup" replace />;
  if (state.phase === 'unlocked' || state.phase === 'locked') {
    return (
      <AuthLayout title="You’re already signed in" lead={`This browser is signed in as ${state.user?.username}. Sign out to create a new account with this invite.`}>
        <div className="auth-form">
          <button type="button" className="btn btn-primary btn-block" onClick={() => void store.signOut()}>
            Sign out
          </button>
          <Link className="btn btn-block" to="/">
            Back to my notes
          </Link>
        </div>
      </AuthLayout>
    );
  }
  if (checkFailed) {
    return (
      <AuthLayout title="Can’t check this invite" lead="The server didn’t answer. Check your connection and reload the page.">
        <div className="auth-form" />
      </AuthLayout>
    );
  }
  if (valid === null) {
    return (
      <AuthLayout title="Checking your invite…">
        <div className="auth-center">
          <Spinner label="Checking invite" />
        </div>
      </AuthLayout>
    );
  }
  if (!valid) {
    return (
      <AuthLayout
        title="This invite link doesn’t work"
        lead="It may have expired or already been used. Ask the person who sent it for a new one."
        footer={<Link to="/login">I already have an account</Link>}
      >
        <div className="auth-form" />
      </AuthLayout>
    );
  }
  return <RegisterFlow title="Join Inked" lead="Create your account." inviteToken={token} step={step} setStep={setStep} />;
}
