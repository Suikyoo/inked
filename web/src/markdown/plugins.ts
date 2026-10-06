import type MarkdownIt from 'markdown-it';
import type StateInline from 'markdown-it/lib/rules_inline/state_inline.mjs';
import type StateCore from 'markdown-it/lib/rules_core/state_core.mjs';
import type Token from 'markdown-it/lib/token.mjs';

export interface WikiLinkEnv {
  /** Returns an in-app href for a note title, or null when no such note exists. */
  resolveWikiLink?: (title: string) => string | null;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** `[[Note title]]` and `[[Note title|label]]`. */
export function wikiLinks(md: MarkdownIt): void {
  md.inline.ruler.before('link', 'wikilink', (state: StateInline, silent: boolean) => {
    const start = state.pos;
    const src = state.src;
    if (src.charCodeAt(start) !== 0x5b || src.charCodeAt(start + 1) !== 0x5b) return false;
    const end = src.indexOf(']]', start + 2);
    if (end < 0 || end > state.posMax) return false;
    const inner = src.slice(start + 2, end);
    if (!inner.trim() || /[\n[\]]/.test(inner)) return false;
    if (!silent) {
      const bar = inner.indexOf('|');
      const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
      const label = (bar >= 0 ? inner.slice(bar + 1) : inner).trim() || target;
      const token = state.push('wikilink', '', 0);
      token.meta = { target, label };
    }
    state.pos = end + 2;
    return true;
  });

  md.renderer.rules.wikilink = (tokens, idx, _opts, env: WikiLinkEnv) => {
    const { target, label } = tokens[idx].meta as { target: string; label: string };
    const href = env?.resolveWikiLink?.(target) ?? null;
    if (href) return `<a class="wl" href="${escapeHtml(href)}" data-wikilink="">${escapeHtml(label)}</a>`;
    return `<span class="wl-missing" title="No note with this title in this vault">${escapeHtml(label)}</span>`;
  };
}

const TASK_RE = /^\[([ xX])\](?=[ \t]|$)[ \t]?/;

/**
 * GitHub-style task lists. Each checkbox carries the source line (`data-line`) so the view
 * can toggle `[ ]`/`[x]` in the Markdown source.
 */
export function taskLists(md: MarkdownIt): void {
  md.core.ruler.after('inline', 'task-lists', (state: StateCore) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const inline = tokens[i];
      if (inline.type !== 'inline' || tokens[i - 1].type !== 'paragraph_open' || tokens[i - 2].type !== 'list_item_open') {
        continue;
      }
      const m = TASK_RE.exec(inline.content);
      const first = inline.children?.[0];
      if (!m || !first || first.type !== 'text' || !TASK_RE.test(first.content)) continue;

      const checked = m[1] !== ' ';
      const line = tokens[i - 1].map?.[0] ?? -1;
      first.content = first.content.replace(TASK_RE, '');
      const label = inline.content.replace(TASK_RE, '').trim().slice(0, 120) || (checked ? 'Done' : 'To do');
      const box = new state.Token('html_inline', '', 0);
      box.content =
        `<input type="checkbox" class="task-checkbox" data-line="${line}"` +
        `${checked ? ' checked' : ''} aria-label="${escapeHtml(label)}">`;
      inline.children!.unshift(box);

      tokens[i - 2].attrJoin('class', 'task-list-item' + (checked ? ' is-done' : ''));
      const list = findParentList(tokens, i - 2);
      if (list && !(list.attrGet('class') ?? '').includes('contains-task-list')) list.attrJoin('class', 'contains-task-list');
    }
  });
}

function findParentList(tokens: Token[], itemIdx: number): Token | null {
  const level = tokens[itemIdx].level - 1;
  for (let j = itemIdx - 1; j >= 0; j--) {
    const t = tokens[j];
    if (t.level === level && (t.type === 'bullet_list_open' || t.type === 'ordered_list_open')) return t;
  }
  return null;
}

const TASK_LINE_RE = /^(\s*(?:>\s*)*(?:[-*+]|\d+[.)])\s+)\[([ xX])\]/;

/** Flips the task checkbox on `line` (0-based). Returns null if that line is not a task item. */
export function toggleTaskAtLine(src: string, line: number): string | null {
  const lines = src.split('\n');
  if (line < 0 || line >= lines.length) return null;
  const m = TASK_LINE_RE.exec(lines[line]);
  if (!m) return null;
  lines[line] = lines[line].replace(TASK_LINE_RE, (_all, pre: string, c: string) => pre + (c === ' ' ? '[x]' : '[ ]'));
  return lines.join('\n');
}

const WIKI_RE = /\[\[([^[\]\n|]+)(?:\|[^[\]\n]*)?\]\]/g;

/** Lower-cased wiki-link targets found in a Markdown body. */
export function wikiLinkTargets(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(WIKI_RE)) out.add(m[1].trim().toLowerCase());
  return out;
}
