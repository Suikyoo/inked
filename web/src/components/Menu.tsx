import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { usePresence } from '../motion';

export interface MenuItem {
  label: string;
  onSelect: () => void;
  danger?: boolean;
  disabled?: boolean;
}

/**
 * Small action menu: a trigger button plus a fixed-position popup (so scroll containers don't clip it).
 * `openSignal` lets a parent open it from the keyboard (e.g. Shift+F10 on a tree row).
 */
export function Menu({
  label,
  items,
  children,
  className = 'ibtn',
  tabIndex,
  openSignal,
}: {
  label: string;
  items: MenuItem[];
  children: ReactNode;
  className?: string;
  tabIndex?: number;
  openSignal?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number; origin: string } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLUListElement | null>(null);
  const presence = usePresence(open, 90);
  const presenceRef = presence.ref;
  const setMenuEl = useCallback(
    (el: HTMLUListElement | null) => {
      menu.current = el;
      presenceRef(el);
    },
    [presenceRef],
  );
  const id = useId();
  const lastSignal = useRef(openSignal);

  useEffect(() => {
    if (openSignal !== undefined && openSignal !== lastSignal.current) {
      lastSignal.current = openSignal;
      setOpen(true);
    }
  }, [openSignal]);

  useLayoutEffect(() => {
    if (!open || !btn.current) return;
    const r = btn.current.getBoundingClientRect();
    const width = 188;
    const height = items.length * 32 + 10;
    const left = Math.max(8, Math.min(r.right - width, window.innerWidth - width - 8));
    const below = r.bottom + 4;
    const top = below + height > window.innerHeight - 8 ? Math.max(8, r.top - height - 4) : below;
    const originX = Math.max(0, Math.min(width, r.left + r.width / 2 - left));
    setPos({ top, left, origin: `${originX}px ${top < r.top ? 'bottom' : 'top'}` });
  }, [open, items.length]);

  useEffect(() => {
    if (!open) return;
    const first = menu.current?.querySelector<HTMLButtonElement>('button:not(:disabled)');
    first?.focus();
    const onDown = (e: MouseEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) setOpen(false);
    };
    const onScroll = () => setOpen(false);
    document.addEventListener('mousedown', onDown);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('resize', onScroll);
    };
  }, [open, pos]);

  const close = (refocus = true) => {
    setOpen(false);
    if (refocus) btn.current?.focus();
  };

  const onKey = (e: KeyboardEvent) => {
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[(i + 1) % buttons.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      buttons[(i - 1 + buttons.length) % buttons.length]?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };

  return (
    <>
      <button
        ref={btn}
        type="button"
        className={className}
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        tabIndex={tabIndex}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => e.stopPropagation()}
      >
        {children}
      </button>
      {presence.mounted &&
        createPortal(
          <ul
            ref={setMenuEl}
            id={id}
            role="menu"
            aria-label={label}
            className="menu"
            data-state={presence.state}
            style={pos ? { top: pos.top, left: pos.left, transformOrigin: pos.origin } : { visibility: 'hidden' }}
            onKeyDown={onKey}
          >
            {items.map((it) => (
              <li role="none" key={it.label}>
                <button
                  type="button"
                  role="menuitem"
                  className={it.danger ? 'menu-item is-danger' : 'menu-item'}
                  disabled={it.disabled}
                  onClick={() => {
                    close(false);
                    it.onSelect();
                  }}
                >
                  {it.label}
                </button>
              </li>
            ))}
          </ul>,
          document.body,
        )}
    </>
  );
}
