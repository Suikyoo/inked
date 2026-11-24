/**
 * The note body editor: one CodeMirror 6 view behind an `EditorHandle`.
 *
 * Everything outside this directory talks to the editor in strings and character offsets, so the engine stays
 * swappable and no other module imports `@codemirror/*`. The surrounding app (autosave, conflicts, the
 * ciphertext queue) is unchanged by this: it only ever saw `value` and `onChange`.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { defaultHighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, drawSelection, highlightSpecialChars, keymap, placeholder as cmPlaceholder } from '@codemirror/view';
import { applyKeymaps, clearKeymaps, loadVim, optionExtensions, type VimApi } from './applyVim';
import { externalChange } from './pushValue';
import type { VimConfig } from './vimConfig';

/** How the rest of the app reaches into the editor: strings and character offsets, never DOM. */
export interface EditorHandle {
  /** The document as it stands right now, ahead of React state. */
  body(): string;
  focus(): void;
  selection(): { start: number; end: number };
  setSelection(start: number, end: number): void;
  /** Replace [start, end) and leave the caret after the inserted text. */
  replaceRange(start: number, end: number, text: string): void;
}

export interface CodeEditorProps {
  value: string;
  onChange: (body: string) => void;
  handleRef: MutableRefObject<EditorHandle | null>;
  /** Null, or vim mode's state. A compiled config with errors contributes no keymaps. */
  vim: { on: boolean; config: VimConfig } | null;
  readOnly?: boolean;
  spellCheck?: boolean;
  placeholder?: string;
  ariaLabel: string;
  onPaste?: (e: ClipboardEvent) => void;
  onDrop?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
}

/**
 * The vim engine, once loaded. Module-level because its mappings are module-level: turning vim off has to
 * clear mappings an earlier editor set, and the dynamic import is cached by the module system anyway.
 */
let vimApi: VimApi | null = null;

/** readOnly and the content attributes, as one extension, for construction and for every later change. */
const stateExtensions = (readOnly: boolean, ariaLabel: string, spellCheck: boolean) => [
  EditorState.readOnly.of(readOnly),
  EditorView.contentAttributes.of({ 'aria-label': ariaLabel, spellcheck: String(spellCheck) }),
];

/**
 * The per-request nonce the server put in `style-src` and in a meta tag.
 *
 * CodeMirror injects its own stylesheet at runtime, and `style-src 'self'` refuses it — the editor then has
 * no base theme at all: the caret is not positioned and there is no selection layer. Passing the nonce is
 * what admits that one stylesheet. Read once, since it does not change while the page is loaded.
 */
const cspNonce = (): string => document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? '';

/** A textarea normalises CRLF and CodeMirror does not, so a Windows paste is flattened on the way in. */
const normalise = (text: string) => text.replace(/\r\n?/g, '\n');

export function CodeEditor({
  value,
  onChange,
  handleRef,
  vim,
  readOnly = false,
  spellCheck = false,
  placeholder = '',
  ariaLabel,
  onPaste,
  onDrop,
  onDragOver,
}: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const vimRoom = useRef(new Compartment());
  const optionRoom = useRef(new Compartment());
  const stateRoom = useRef(new Compartment());
  const wrapRoom = useRef(new Compartment());
  /** Live props the CodeMirror callbacks read, so the view is built once and never rebuilt. */
  const live = useRef({ onChange, onPaste, onDrop, onDragOver });
  live.current = { onChange, onPaste, onDrop, onDragOver };
  /** True while we are pushing React's value in, so that dispatch is not echoed back out. */
  const pushing = useRef(false);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const view = new EditorView({
      parent: host,
      state: EditorState.create({
        doc: normalise(value),
        extensions: [
          // Vim first: its bindings must win over the default keymap.
          vimRoom.current.of([]),
          history(),
          drawSelection(),
          highlightSpecialChars(),
          markdown(),
          syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
          search(),
          // Without this CodeMirror resolves its own base theme's `&light` branches — a dark caret and a
          // light-grey selection on this app's near-black paper. The app has no light mode to switch to.
          EditorView.darkTheme.of(true),
          EditorView.cspNonce.of(cspNonce()),
          keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
          // Wrapping is on as the textarea's was; `vim.o.wrap = false` is the only thing that turns it off.
          wrapRoom.current.of(EditorView.lineWrapping),
          optionRoom.current.of([]),
          stateRoom.current.of(stateExtensions(readOnly, ariaLabel, spellCheck)),
          cmPlaceholder(placeholder),
          EditorView.updateListener.of((u) => {
            if (u.docChanged && !pushing.current) live.current.onChange(u.state.doc.toString());
          }),
          EditorView.domEventHandlers({
            paste: (e) => live.current.onPaste?.(e),
            drop: (e) => live.current.onDrop?.(e),
            dragover: (e) => live.current.onDragOver?.(e),
          }),
        ],
      }),
    });
    viewRef.current = view;
    handleRef.current = {
      body: () => view.state.doc.toString(),
      focus: () => view.focus(),
      selection: () => ({ start: view.state.selection.main.from, end: view.state.selection.main.to }),
      setSelection: (start, end) => view.dispatch({ selection: { anchor: start, head: end } }),
      replaceRange: (start, end, text) =>
        view.dispatch({ changes: { from: start, to: end, insert: text }, selection: { anchor: start + text.length } }),
    };
    // A value that needed normalising must reach the store too, or it would be pushed back in on every render.
    const normalised = normalise(value);
    if (normalised !== value) live.current.onChange(normalised);
    return () => {
      view.destroy();
      viewRef.current = null;
      handleRef.current = null;
    };
    // Built once: later prop changes are carried by the effects below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // React's value, pushed in only when it actually differs from the document.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const next = normalise(value);
    const current = view.state.doc.toString();
    if (next === current) return;
    pushing.current = true;
    view.dispatch(externalChange(current.length, next));
    pushing.current = false;
    if (next !== value) live.current.onChange(next);
  }, [value]);

  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({ effects: stateRoom.current.reconfigure(stateExtensions(readOnly, ariaLabel, spellCheck)) });
  }, [readOnly, spellCheck, ariaLabel]);

  // Vim mode. The package is only fetched once it is actually wanted; its mappings are module-global.
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    if (!vim?.on) {
      view.dispatch({
        effects: [
          vimRoom.current.reconfigure([]),
          optionRoom.current.reconfigure([]),
          wrapRoom.current.reconfigure(EditorView.lineWrapping),
        ],
      });
      if (vimApi) clearKeymaps(vimApi);
      return;
    }
    let alive = true;
    void (async () => {
      const { extension, api } = await loadVim(vim.config.keymaps);
      vimApi = api;
      if (!alive || !viewRef.current) return;
      applyKeymaps(api, vim.config.keymaps);
      viewRef.current.dispatch({
        effects: [
          vimRoom.current.reconfigure(extension),
          optionRoom.current.reconfigure(optionExtensions(vim.config.options)),
          wrapRoom.current.reconfigure(vim.config.options.wrap === false ? [] : EditorView.lineWrapping),
        ],
      });
    })();
    return () => {
      alive = false;
    };
  }, [vim]);

  return <div ref={hostRef} className="editor editor-cm" />;
}

