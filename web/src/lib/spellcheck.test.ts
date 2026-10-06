// @vitest-environment jsdom
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { PromptDialog } from '../components/Dialog';
import { prefs } from './prefs';

const SRC = path.resolve(__dirname, '..');

function tsxFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return tsxFiles(p);
    return e.name.endsWith('.tsx') ? [p] : [];
  });
}

/** The attribute text of every JSX `<input`, `<textarea` and `<TextField` opening tag in `source`. */
function fieldTags(source: string): string[] {
  const tags: string[] = [];
  for (const m of source.matchAll(/<(input|textarea|TextField)\b/g)) {
    let depth = 0;
    let quote: string | null = null;
    let i = m.index! + m[0].length;
    for (; i < source.length; i++) {
      const c = source[i];
      if (quote) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '{') depth++;
      else if (c === '}') depth--;
      else if (c === '>' && depth === 0) break;
    }
    tags.push(source.slice(m.index!, i + 1));
  }
  return tags;
}

/** Fields nobody types into: checkboxes, colour pickers, hidden and read-only fields, pass-through wrappers. */
const notTyped = (tag: string) =>
  /type="(checkbox|color|hidden)"/.test(tag) || /\s(hidden|readOnly)[\s/>]/.test(tag) || /\{\.\.\.\w+\}/.test(tag);

describe('spell-check (I-1)', () => {
  afterEach(() => localStorage.clear());

  it('every text field states its spell-check, so none falls back to the browser default', () => {
    const missing: string[] = [];
    for (const file of tsxFiles(SRC)) {
      for (const tag of fieldTags(readFileSync(file, 'utf8'))) {
        if (!notTyped(tag) && !/\sspellCheck=/.test(tag)) missing.push(`${path.relative(SRC, file)}: ${tag.split('\n')[0]}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('a name typed into a prompt dialog follows the spell-check preference', async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    const host = document.createElement('div');
    document.body.append(host);
    /** Opens a fresh prompt and returns its input's spellcheck attribute. */
    const spellcheckOfPrompt = async () => {
      const root = createRoot(host);
      const props = { open: true, title: 'New folder', label: 'Name', onSubmit: () => undefined, onClose: () => undefined };
      await act(async () => root.render(createElement(PromptDialog, props)));
      const value = document.getElementById('prompt-input')?.getAttribute('spellcheck');
      await act(async () => root.unmount());
      return value;
    };
    try {
      expect(await spellcheckOfPrompt()).toBe('false');
      prefs.setSpellcheck(true);
      expect(await spellcheckOfPrompt()).toBe('true');
    } finally {
      host.remove();
    }
  });
});
