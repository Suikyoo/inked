// @vitest-environment jsdom
import { EditorState } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { Vim, getCM, vim } from '@replit/codemirror-vim';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyKeymaps, clearKeymaps } from './applyVim';
import { compileVimConfig } from './vimConfig';
import { vimKeySequences } from './vimKeySequences';

let view: EditorView;
function mount(source: string) {
  const { keymaps } = compileVimConfig(source);
  applyKeymaps(Vim, keymaps);
  view = new EditorView({
    state: EditorState.create({ doc: 'abcdef', extensions: [vimKeySequences(keymaps), vim()] }),
    parent: document.body,
  });
}

function press(...keys: string[]) {
  for (const key of keys) view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', {
    key, keyCode: key === ' ' ? 32 : key.toUpperCase().charCodeAt(0), bubbles: true, cancelable: true,
  }));
}

afterEach(() => {
  view?.destroy();
  clearKeymaps(Vim);
  vi.useRealTimers();
});

describe('configured Vim sequences', () => {
  it('uses the longest matching keymap even when shorter keys are full commands', () => {
    mount("vim.keymap.set('n','g','l')\nvim.keymap.set('n','ggx','5l')");
    press('g', 'g', 'x');
    expect(view.state.selection.main.head).toBe(5);
    expect(view.state.doc.toString()).toBe('abcdef');
  });

  it('runs the shorter mapping on timeout and keeps the following motion on mismatch', () => {
    vi.useFakeTimers();
    mount("vim.keymap.set('n','s','l')\nvim.keymap.set('n','sa','5l')");
    press('s');
    vi.advanceTimersByTime(1000);
    expect(view.state.selection.main.head).toBe(1);
    press('s', 'l');
    expect(view.state.selection.main.head).toBe(3);
  });

  it('retains native motions in the other mode and after clearing mappings', () => {
    mount("vim.keymap.set('v','la','$')");
    press('l');
    expect(view.state.selection.main.head).toBe(1);
    clearKeymaps(Vim);
    press('l');
    expect(view.state.selection.main.head).toBe(2);
  });

  it('lets a recursive mapping invoke an entire configured sequence', () => {
    mount("vim.keymap.set('n','sa','5l')\nvim.keymap.set('n','Q','sa',{remap=true})");
    press('Q');
    expect(getCM(view)?.state.vim?.insertMode).toBe(false);
    expect(view.state.selection.main.head).toBe(5);
  });
});
