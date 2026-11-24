import { Prec, type Extension } from '@codemirror/state';
import { ViewPlugin, type EditorView } from '@codemirror/view';
import { Vim, getCM } from '@replit/codemirror-vim';
import type { VimKeymap, VimMode } from './vimConfig';

const tokens = (lhs: string) => lhs.match(/<[^<>]+>|[\s\S]/gu) ?? [];

/**
 * CodeMirror's Vim matcher executes a complete command immediately, even if a configured
 * sequence also starts with it. Look ahead only for user-defined sequences, in their mode.
 * Pass a completed sequence to the engine as one input so Vim still owns counts, operators,
 * recursive mappings, registers and the command itself.
 */
export function vimKeySequences(keymaps: VimKeymap[]): Extension {
  const keys: Record<VimMode, string[][]> = { n: [], v: [], i: [] };
  for (const { modes, lhs } of keymaps) {
    for (const mode of modes) keys[mode].push(tokens(lhs));
  }
  // The native insert handler already displays typed prefixes immediately and rolls them
  // back on completion. Only ambiguous insert bindings need our extra lookahead.
  const ambiguousInsert = keys.i.filter((a) =>
    keys.i.some((b) => a.length < b.length && a.every((key, i) => b[i] === key)),
  );
  if (!Object.values(keys).some((bindings) => bindings.some((m) => m.length > 1))) return [];

  return Prec.highest(ViewPlugin.fromClass(class {
    pending: string[] = [];
    exact = 0;
    timer?: ReturnType<typeof setTimeout>;

    constructor(readonly view: EditorView) {}

    reset() {
      clearTimeout(this.timer);
      this.pending = [];
      this.exact = 0;
    }

    destroy() { this.reset(); }

    flush() {
      const cm = getCM(this.view);
      const pending = this.pending;
      const exact = this.exact;
      this.reset();
      if (!cm || !pending.length) return;
      if (exact) Vim.multiSelectHandleKey(cm, pending.slice(0, exact).join(''), 'user');
      if (exact === pending.length) return;

      // Replay the unmatched prefix with native Vim semantics. A temporary noremap
      // prevents it from immediately starting the same incomplete mapping again.
      const state = cm.state.vim;
      const context = state?.insertMode ? 'insert' : state?.visualMode ? 'visual' : 'normal';
      const replay = '<InkedReplay>';
      Vim.noremap(replay, pending.slice(exact).join(''), context);
      try {
        Vim.multiSelectHandleKey(cm, replay, 'mapping');
      } finally {
        Vim.unmap(replay, context);
      }
    }

    keydown(e: KeyboardEvent): boolean {
      const cm = getCM(this.view);
      const state = cm?.state.vim;
      if (!cm || !state || e.isComposing) return false;
      const key = Vim.vimKeyFromEvent(e, state);
      if (!key) return false;
      if (key === '<Esc>' && this.pending.length) {
        if (state.insertMode) this.flush();
        else this.reset();
        return false;
      }
      const buffer = state.inputState.keyBuffer;
      if (state.insertMode && buffer.length && keys.i.some((m) => m[0] === key)) {
        const next = [...buffer, key];
        if (!keys.i.some((m) => next.every((k, i) => m[i] === k))) {
          // E.g. the second j in jjk starts a fresh jk. The previous j is already
          // visible text. An unbound key clears Vim's stale insert change queue.
          Vim.handleKey(cm, '<InkedResetPrefix>', 'mapping');
        }
      }
      if (state.inputState.operator || state.inputState.keyBuffer.some((k) => !/^\d+$/.test(k))) return false;
      const mode = state.insertMode ? 'i' : state.visualMode ? 'v' : 'n';
      if (mode === 'i' && !this.pending.length && !ambiguousInsert.some((m) => m[0] === key)) return false;

      const sequence = [...this.pending, key];
      const matches = keys[mode].filter((m) => sequence.every((k, i) => m[i] === k));
      if (!matches.length) {
        if (!this.pending.length) return false;
        this.flush();
        return this.keydown(e);
      }
      if (!this.pending.length && matches.every((m) => m.length === 1)) return false;
      this.pending = sequence;
      if (matches.some((m) => m.length === sequence.length)) this.exact = sequence.length;
      clearTimeout(this.timer);
      if (matches.every((m) => m.length === sequence.length)) {
        this.flush();
      } else {
        this.timer = setTimeout(() => this.flush(), mode === 'i' ? 200 : 1000);
      }
      e.stopPropagation();
      return true;
    }
  }, {
    eventHandlers: {
      keydown(e) { return this.keydown(e); },
      blur() { if (getCM(this.view)?.state.vim?.insertMode) this.flush(); else this.reset(); },
      pointerdown() { if (getCM(this.view)?.state.vim?.insertMode) this.flush(); else this.reset(); },
    },
  }));
}
