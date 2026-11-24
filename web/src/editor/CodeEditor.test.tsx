// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CodeEditor, type EditorHandle } from './CodeEditor';
import type { VimConfig } from './vimConfig';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

/** Mounts the editor and returns its handle plus the onChange spy. */
function mount(value: string, onChange = vi.fn()) {
  const handleRef: { current: EditorHandle | null } = { current: null };
  act(() => {
    root.render(<CodeEditor value={value} onChange={onChange} handleRef={handleRef} vim={null} ariaLabel="Markdown source" />);
  });
  return { handle: () => handleRef.current!, onChange, rerender: (v: string) => act(() => {
    root.render(<CodeEditor value={v} onChange={onChange} handleRef={handleRef} vim={null} ariaLabel="Markdown source" />);
  }) };
}

describe('CodeEditor', () => {
  it('reports document changes through onChange', () => {
    const e = mount('ab');
    act(() => e.handle().replaceRange(1, 1, 'X'));
    expect(e.onChange).toHaveBeenCalledWith('aXb');
  });

  it('dispatches an external value change', () => {
    const e = mount('ab');
    e.rerender('zz');
    expect(e.handle().body()).toBe('zz');
  });

  it('does not re-dispatch an echo of its own change', () => {
    const e = mount('ab');
    act(() => e.handle().setSelection(1, 2));
    e.rerender('ab');
    expect(e.handle().selection()).toEqual({ start: 1, end: 2 });
  });

  it('normalises CRLF in an incoming value', () => {
    const e = mount('a\r\nb');
    expect(e.handle().body()).toBe('a\nb');
    expect(e.onChange).toHaveBeenCalledWith('a\nb');
  });

  it('exposes the live document ahead of React state', () => {
    const e = mount('ab');
    act(() => e.handle().replaceRange(2, 2, 'c'));
    expect(e.handle().body()).toBe('abc');
  });

  it('reads and sets the selection as offsets', () => {
    const e = mount('abcd');
    act(() => e.handle().setSelection(1, 3));
    expect(e.handle().selection()).toEqual({ start: 1, end: 3 });
  });

  it('replaceRange inserts and leaves the caret after the text', () => {
    const e = mount('ab');
    act(() => e.handle().replaceRange(1, 1, 'XY'));
    expect(e.handle().body()).toBe('aXYb');
    expect(e.handle().selection()).toEqual({ start: 3, end: 3 });
  });

  it('exports nothing but the component', async () => {
    expect(Object.keys(await import('./CodeEditor'))).toEqual(['CodeEditor']);
  });
});

describe('CodeEditor wrapping', () => {
  const wrapping = () => !!host.querySelector('.cm-content')?.classList.contains('cm-lineWrapping');

  it('wraps long lines by default, as the textarea did', () => {
    mount('ab');
    expect(wrapping()).toBe(true);
  });

  it('stops wrapping when the config says vim.o.wrap = false', async () => {
    const handleRef: { current: EditorHandle | null } = { current: null };
    const vim = { on: true, config: { keymaps: [], options: { wrap: false }, globals: {}, errors: [] } };
    await act(async () => {
      root.render(<CodeEditor value="ab" onChange={() => undefined} handleRef={handleRef} vim={vim} ariaLabel="Markdown source" />);
    });
    // Wait for the lazy extension to arrive before inspecting the view.
    await vi.waitFor(() => expect(wrapping()).toBe(false));
  });
});

describe('CodeEditor turning vim off', () => {
  it('clears the mappings vim mode set, since they are global to the engine', async () => {
    const handleRef: { current: EditorHandle | null } = { current: null };
    const render = (vim: { on: boolean; config: VimConfig } | null) =>
      act(async () => {
        root.render(<CodeEditor value="ab" onChange={() => undefined} handleRef={handleRef} vim={vim} ariaLabel="Markdown source" />);
      });
    const settle = () => act(async () => void (await new Promise((r) => setTimeout(r, 0))));

    await render({ on: true, config: { keymaps: [{ modes: ['i'], lhs: 'jk', rhs: '<Esc>', remap: false }], options: {}, globals: {}, errors: [] } });
    await settle();
    const { Vim } = await import('@replit/codemirror-vim');
    const cleared: string[] = [];
    const spy = vi.spyOn(Vim as unknown as { mapclear: (c?: string) => void }, 'mapclear').mockImplementation((c?: string) => {
      cleared.push(c ?? '');
    });
    try {
      await render(null);
      await settle();
      expect(cleared).toEqual(['normal', 'insert', 'visual']);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CodeEditor toggling vim off before its engine arrives', () => {
  it('never applies the keymaps of a config that was turned off mid-import', async () => {
    const handleRef: { current: EditorHandle | null } = { current: null };
    const render = (vim: { on: boolean; config: VimConfig } | null) =>
      root.render(<CodeEditor value="ab" onChange={() => undefined} handleRef={handleRef} vim={vim} ariaLabel="Markdown source" />);

    // Cached, so the dynamic import inside the effect resolves on a microtask rather than a file read.
    const { Vim } = await import('@replit/codemirror-vim');
    const applied: string[] = [];
    const spy = vi.spyOn(Vim as unknown as { noremap: (l: string, r: string, c: string) => void }, 'noremap').mockImplementation((l) => {
      applied.push(l);
    });
    try {
      const config: VimConfig = { keymaps: [{ modes: ['n'], lhs: 'H', rhs: '^', remap: false }], options: {}, globals: {}, errors: [] };
      // Two synchronous commits: the on-effect runs and starts the import, then the off-effect runs before
      // the import's continuation can — no await point between them for a microtask to slip through.
      act(() => render({ on: true, config }));
      act(() => render(null));
      await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
      expect(applied).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});

describe('CodeEditor and the style nonce', () => {
  /**
   * `style-src 'self'` blocks CodeMirror's injected stylesheet outright, which leaves the editor with no
   * base theme at all — an unpositioned caret and no selection layer. The server puts a per-request nonce
   * in the policy and in a meta tag; the editor has to pass it on or the stylesheet is still refused.
   */
  const meta = (content: string) => {
    const el = document.createElement('meta');
    el.name = 'csp-nonce';
    el.content = content;
    document.head.append(el);
    return el;
  };

  it('stamps the page nonce onto the stylesheet it injects', () => {
    const el = meta('test-nonce-abc');
    try {
      const handleRef: { current: EditorHandle | null } = { current: null };
      act(() => {
        root.render(<CodeEditor value="ab" onChange={() => undefined} handleRef={handleRef} vim={null} ariaLabel="Markdown source" />);
      });
      const styles = [...document.head.querySelectorAll('style')].map((s) => s.getAttribute('nonce'));
      expect(styles).toContain('test-nonce-abc');
    } finally {
      el.remove();
    }
  });
});
