// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { InkFill } from './InkFill';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(done: boolean) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InkFill done={done} />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('InkFill', () => {
  it('renders a drop svg with a masked fill rect that sits at 85% while pending', () => {
    const el = render(false);
    expect(el.querySelector('svg')).not.toBeNull();
    const rect = el.querySelector('mask rect[data-ink-level]');
    expect(rect).not.toBeNull();
    expect(Number(rect!.getAttribute('y'))).toBeGreaterThan(0);
    expect(el.querySelector('svg')!.classList.contains('is-done')).toBe(false);
  });

  it('fills to the top when done', () => {
    const el = render(true);
    expect(el.querySelector('mask rect[data-ink-level]')!.getAttribute('y')).toBe('0');
    expect(el.querySelector('svg')!.classList.contains('is-done')).toBe(true);
  });
});
