// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ModeToggle, SaveIndicator } from './NotePane';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;
function mount(node: React.ReactNode) {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(node));
  return { host, rerender: (n: React.ReactNode) => act(() => root!.render(n)) };
}
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = null;
  host = null;
});

describe('ModeToggle', () => {
  it('carries data-mode and flips with the mode', () => {
    const onChange = vi.fn();
    const m = mount(<ModeToggle mode="edit" onChange={onChange} />);
    const seg = () => m.host.querySelector('.segmented')!;
    expect(seg().getAttribute('data-mode')).toBe('edit');
    m.rerender(<ModeToggle mode="view" onChange={onChange} />);
    expect(seg().getAttribute('data-mode')).toBe('view');
    act(() => (m.host.querySelectorAll('button')[0] as HTMLButtonElement).click());
    expect(onChange).toHaveBeenCalledWith('edit');
  });
});

describe('SaveIndicator', () => {
  it('carries data-save and remounts its text when the label changes', () => {
    const m = mount(<SaveIndicator status="saving" ready />);
    const el = () => m.host.querySelector('.save-status')!;
    expect(el().getAttribute('data-save')).toBe('saving');
    const first = el().querySelector('.save-text');
    m.rerender(<SaveIndicator status="saved" ready />);
    expect(el().getAttribute('data-save')).toBe('saved');
    expect(el().querySelector('.save-text')).not.toBe(first);
    expect(el().textContent).toBe('Saved');
  });

  it('reads idle as saved once the note is ready', () => {
    const m = mount(<SaveIndicator status="idle" ready />);
    expect(m.host.querySelector('.save-status')!.getAttribute('data-save')).toBe('saved');
  });
});
