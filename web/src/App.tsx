import { useEffect, type ReactNode } from 'react';
import { BrowserRouter, Link, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Logo } from './brand/Logo';
import { AppShell } from './components/AppShell';
import { Spinner } from './components/Fields';
import { HomePage } from './pages/HomePage';
import { LoginPage } from './pages/LoginPage';
import { RecoverPage } from './pages/RecoverPage';
import { SettingsPage } from './pages/SettingsPage';
import { JoinPage, SetupPage } from './pages/SetupPage';
import { VaultPage } from './pages/VaultPage';
import { AuthLayout } from './pages/AuthLayout';
import { InsecureContextPage } from './pages/InsecureContextPage';
import { SemanticProvider } from './semantic/SemanticContext';
import type { SemanticStore } from './semantic/semanticStore';
import { AccountSettingsProvider } from './state/AccountSettingsContext';
import type { AccountSettingsStore } from './state/accountSettings';
import { AppStore } from './state/store';
import { StoreProvider, useAppState, useStore } from './state/StoreContext';

/** Pages that need unlocked keys. Anyone else goes to setup or the unlock screen. */
function RequireUnlocked({ children }: { children: ReactNode }) {
  const { phase } = useAppState();
  const location = useLocation();
  if (phase === 'setup') return <Navigate to="/setup" replace />;
  if (phase !== 'unlocked') return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

/** Login and recovery: once unlocked, go back to where the user was. */
function PublicOnly({ children }: { children: ReactNode }) {
  const { phase } = useAppState();
  const location = useLocation();
  if (phase === 'setup') return <Navigate to="/setup" replace />;
  if (phase === 'unlocked') {
    const from = (location.state as { from?: string } | null)?.from;
    const safe = from && from.startsWith('/') && !from.startsWith('//') ? from : '/';
    return <Navigate to={safe} replace />;
  }
  return <>{children}</>;
}

function Gate({ children }: { children: ReactNode }) {
  const state = useAppState();
  const store = useStore();
  if (state.phase === 'booting') {
    return (
      <div className="splash" aria-busy="true">
        <Logo size={36} />
        <Spinner label="Loading Inked" />
      </div>
    );
  }
  if (state.phase === 'offline') {
    return (
      <AuthLayout title="Can’t reach the server" lead="Inked couldn’t connect. Check that the server is running, then try again.">
        <div className="auth-form">
          <button type="button" className="btn btn-primary btn-block" onClick={() => void store.boot()}>
            Try again
          </button>
        </div>
      </AuthLayout>
    );
  }
  return <>{children}</>;
}

function NotFound() {
  return (
    <AuthLayout title="Nothing here" lead="This page doesn’t exist.">
      <div className="auth-form">
        <Link className="btn btn-primary btn-block" to="/">
          Go home
        </Link>
      </div>
    </AuthLayout>
  );
}

export function App({ store, semantic, account }: { store: AppStore; semantic: SemanticStore; account: AccountSettingsStore }) {
  // Only an explicit false (or missing WebCrypto) counts as insecure; test DOMs may leave isSecureContext undefined.
  const insecure = window.isSecureContext === false || !globalThis.crypto?.subtle;

  useEffect(() => {
    if (!insecure) void store.boot();
  }, [store, insecure]);

  if (insecure) return <InsecureContextPage />;

  return (
    <StoreProvider store={store}>
      <AccountSettingsProvider store={account}>
        <SemanticProvider store={semantic}>
          <BrowserRouter>
            <Gate>
              <Routes>
                <Route path="/setup" element={<SetupPage />} />
                <Route path="/join/:token" element={<JoinPage />} />
                <Route
                  path="/login"
                  element={
                    <PublicOnly>
                      <LoginPage />
                    </PublicOnly>
                  }
                />
                {/* Guards itself: it stays mounted after unlocking to show the replacement recovery key. */}
                <Route path="/recover" element={<RecoverPage />} />
                <Route
                  element={
                    <RequireUnlocked>
                      <AppShell />
                    </RequireUnlocked>
                  }
                >
                  <Route index element={<HomePage />} />
                  <Route path="v/:vaultId" element={<VaultPage />} />
                  <Route path="v/:vaultId/n/:noteId" element={<VaultPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Gate>
          </BrowserRouter>
        </SemanticProvider>
      </AccountSettingsProvider>
    </StoreProvider>
  );
}
