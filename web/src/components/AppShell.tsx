import { useEffect, useRef, useState } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Logo, Wordmark } from '../brand/Logo';
import { useAppState, useStore } from '../state/StoreContext';
import { CloseIcon, LockIcon, MenuIcon } from './Icons';
import { Sidebar } from './Sidebar';

const IDLE_MS = 15 * 60 * 1000;

export const FOCUS_SEARCH_EVENT = 'inked:focus-search';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/** Locks after 15 minutes without keyboard, pointer or wheel input. */
function useIdleLock(onIdle: () => void) {
  const last = useRef(Date.now());
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    const bump = () => {
      last.current = Date.now();
    };
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'input'] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true, capture: true });
    // Checking on an interval (and on tab focus) also covers a sleeping laptop.
    const check = () => {
      if (Date.now() - last.current >= IDLE_MS) cb.current();
    };
    const t = window.setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump, { capture: true });
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, []);
}

export function AppShell() {
  const store = useStore();
  const state = useAppState();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useIdleLock(() => void store.lock('Locked after 15 minutes without activity.'));

  // Close the mobile drawer on navigation.
  useEffect(() => setDrawer(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !isEditable(e.target)) {
        e.preventDefault();
        if (location.pathname === '/') window.dispatchEvent(new Event(FOCUS_SEARCH_EVENT));
        else navigate('/', { state: { focusSearch: true } });
      } else if (e.key === 'Escape' && drawer) {
        setDrawer(false);
        menuBtn.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [location.pathname, navigate, drawer]);

  const lock = () => void store.lock();

  return (
    <div className={drawer ? 'shell drawer-open' : 'shell'}>
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <button
          ref={menuBtn}
          type="button"
          className="ibtn"
          aria-label={drawer ? 'Close menu' : 'Open menu'}
          aria-expanded={drawer}
          aria-controls="sidebar"
          onClick={() => setDrawer((d) => !d)}
        >
          {drawer ? <CloseIcon /> : <MenuIcon />}
        </button>
        <Link to="/" className="brand" aria-label="Inked home">
          <Logo size={18} />
          <Wordmark />
        </Link>
        <button type="button" className="ibtn" aria-label="Lock all vaults" onClick={lock}>
          <LockIcon />
        </button>
      </header>
      <div className="scrim" aria-hidden="true" onClick={() => setDrawer(false)} />
      <Sidebar id="sidebar" onLock={lock} />
      <div className="main" id="main" tabIndex={-1}>
        {state.pendingCount > 0 && (
          <div className="sync-bar" role="status">
            <span>
              {state.pendingCount} {state.pendingCount === 1 ? 'change' : 'changes'} waiting to sync. Inked will keep
              trying.
            </span>
            <button type="button" className="sync-bar-btn" onClick={() => void store.retryPending()}>
              Try now
            </button>
          </div>
        )}
        {state.notice && (
          <div className="banner" role="status">
            <span>{state.notice}</span>
            <button type="button" className="ibtn ibtn-sm" aria-label="Dismiss" onClick={() => store.clearNotice()}>
              <CloseIcon size={12} />
            </button>
          </div>
        )}
        <Outlet />
      </div>
    </div>
  );
}
