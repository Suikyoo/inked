import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Logo, Wordmark } from '../brand/Logo';
import { useAppState, useStore } from '../state/StoreContext';
import type { AppStore } from '../state/store';
import { usePresence } from '../motion';
import { CloseIcon, LockIcon, MenuIcon } from './Icons';
import { ModelBanner } from './ModelBanner';
import { Sidebar } from './Sidebar';

const IDLE_MS = 15 * 60 * 1000;

export const FOCUS_SEARCH_EVENT = 'inked:focus-search';

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName);
}

/**
 * Locks after 15 minutes without keyboard, pointer or wheel input in any tab of this browser
 * (activity is shared through the store, so a background tab never locks under an active one).
 */
function useIdleLock(store: AppStore, onIdle: () => void) {
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    const bump = () => store.markActive();
    bump(); // unlocking counts as activity
    const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'touchstart', 'input'] as const;
    for (const ev of events) window.addEventListener(ev, bump, { passive: true, capture: true });
    // Checking on an interval (and on tab focus) also covers a sleeping laptop.
    const check = () => {
      if (store.idleMs() >= IDLE_MS) cb.current();
    };
    const t = window.setInterval(check, 15_000);
    document.addEventListener('visibilitychange', check);
    return () => {
      for (const ev of events) window.removeEventListener(ev, bump, { capture: true });
      window.clearInterval(t);
      document.removeEventListener('visibilitychange', check);
    };
  }, [store]);
}

/** Animates a banner in and out, holding its last content while it collapses. */
function Collapse({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted, state, ref } = usePresence(open, 140);
  const last = useRef(children);
  if (open) last.current = children;
  if (!mounted) return null;
  return (
    <div ref={ref} className="collapse" data-state={state} {...(state === 'exit' ? { inert: '' } : {})}>
      <div className="collapse-inner">{last.current}</div>
    </div>
  );
}

export function AppShell() {
  const store = useStore();
  const state = useAppState();
  const location = useLocation();
  const navigate = useNavigate();
  const [drawer, setDrawer] = useState(false);
  const menuBtn = useRef<HTMLButtonElement>(null);

  useIdleLock(store, () => void store.lock('Locked after 15 minutes without activity.'));

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
        <ModelBanner />
        <Collapse open={state.pendingCount > 0}>
          <div className="sync-bar" role="status">
            <span>
              {state.pendingCount} {state.pendingCount === 1 ? 'change' : 'changes'} waiting to sync. Inked will keep
              trying.
            </span>
            <button type="button" className="sync-bar-btn" onClick={() => void store.retryPending()}>
              Try now
            </button>
          </div>
        </Collapse>
        <Collapse open={!!state.notice}>
          <div className="banner" role="status">
            <span>{state.notice}</span>
            <button type="button" className="ibtn ibtn-sm" aria-label="Dismiss" onClick={() => store.clearNotice()}>
              <CloseIcon size={12} />
            </button>
          </div>
        </Collapse>
        <div key={location.pathname} className="route" data-route={location.pathname}>
          <Outlet />
        </div>
      </div>
    </div>
  );
}
