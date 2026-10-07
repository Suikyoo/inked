// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu } from './Menu';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  vi.useFakeTimers();
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root.render(<Menu label="Actions" items={[{ label: 'Rename', onSelect: () => {} }]}>x</Menu>));
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.useRealTimers();
});

const trigger = () => host.querySelector<HTMLButtonElement>('button[aria-haspopup=menu]')!;
const menu = () => document.querySelector<HTMLElement>('[role=menu]');
const click = () => act(() => void trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })));
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('Menu motion', () => {
  it('stays mounted as data-state=exit after closing, then unmounts on animationend', () => {
    click();
    tick(50);
    expect(menu()?.getAttribute('data-state')).toBe('open');
    click();
    expect(menu()?.getAttribute('data-state')).toBe('exit');
    act(() => void menu()!.dispatchEvent(new Event('animationend')));
    expect(menu()).toBeNull();
  });

  it('focuses the first item once mounted, and makes the exiting menu inert', () => {
    click();
    tick(50);
    expect(document.activeElement).toBe(document.querySelector('[role=menuitem]'));
    click();
    expect(menu()?.hasAttribute('inert')).toBe(true);
  });

  it('reopens during the exit', () => {
    click();
    tick(50);
    click();
    expect(menu()?.getAttribute('data-state')).toBe('exit');
    click();
    tick(50);
    expect(menu()?.getAttribute('data-state')).toBe('open');
    tick(500);
    expect(menu()).not.toBeNull();
  });

  it('leaves no menu behind after rapid open/close', () => {
    for (let i = 0; i < 5; i++) {
      click();
      click();
    }
    tick(500);
    expect(menu()).toBeNull();
  });
});
