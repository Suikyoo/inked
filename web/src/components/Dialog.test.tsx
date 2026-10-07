// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dialog } from './Dialog';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root;
let host: HTMLElement;
beforeEach(() => {
  // jsdom has no showModal/close.
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
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

const render = (open: boolean) =>
  act(() =>
    root.render(
      <Dialog open={open} title="Hello" onClose={() => {}}>
        <p>content</p>
      </Dialog>,
    ),
  );
const body = () => host.querySelector('.dialog-body');
const tick = (ms: number) => act(() => void vi.advanceTimersByTime(ms));

describe('Dialog body presence', () => {
  it('keeps the body through the exit, then removes it', () => {
    render(true);
    tick(50);
    expect(body()).not.toBeNull();
    render(false);
    expect(body()).not.toBeNull();
    tick(300);
    expect(body()).toBeNull();
  });

  it('removes the body on transitionend of the dialog', () => {
    render(true);
    tick(50);
    render(false);
    act(() => void host.querySelector('dialog')!.dispatchEvent(new Event('transitionend')));
    expect(body()).toBeNull();
  });
});
