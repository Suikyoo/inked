// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePresence } from './presence';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Host({ open, exitMs = 100 }: { open: boolean; exitMs?: number }) {
  const p = usePresence(open, exitMs);
  return p.mounted ? <div ref={p.ref} data-state={p.state} data-testid="el" /> : null;
}

let root: Root;
let host: HTMLElement;
const render = (open: boolean) => act(() => root.render(<Host open={open} />));
const el = () => host.querySelector('[data-testid=el]');
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

describe('usePresence', () => {
  it('mounts as enter, then open on the next tick', () => {
    render(true);
    expect(el()?.getAttribute('data-state')).toBe('enter');
    tick(50);
    expect(el()?.getAttribute('data-state')).toBe('open');
  });

  it('starts closed and unmounted', () => {
    render(false);
    expect(el()).toBeNull();
  });

  it('exits, then unmounts on animationend', () => {
    render(true);
    tick(50);
    render(false);
    expect(el()?.getAttribute('data-state')).toBe('exit');
    act(() => void el()!.dispatchEvent(new Event('animationend')));
    expect(el()).toBeNull();
  });

  it('unmounts on transitionend', () => {
    render(true);
    tick(50);
    render(false);
    act(() => void el()!.dispatchEvent(new Event('transitionend')));
    expect(el()).toBeNull();
  });

  it('unmounts after exitMs + 50 without an animation event', () => {
    render(true);
    tick(50);
    render(false);
    tick(149);
    expect(el()).not.toBeNull();
    tick(1);
    expect(el()).toBeNull();
  });

  it('re-opening during an exit cancels it', () => {
    render(true);
    tick(50);
    render(false);
    tick(60);
    render(true);
    tick(500);
    expect(el()?.getAttribute('data-state')).toBe('open');
  });

  it('rapid true/false/true/false ends unmounted', () => {
    render(true);
    render(false);
    render(true);
    render(false);
    tick(500);
    expect(el()).toBeNull();
  });
});
