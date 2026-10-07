import MarkdownIt from 'markdown-it';
import createDOMPurify, { type DOMPurify } from 'dompurify';
import { taskLists, wikiLinks, type WikiLinkEnv } from './plugins';

export { toggleTaskAtLine, wikiLinkTargets } from './plugins';

// CommonMark + GFM tables/strikethrough (markdown-it defaults), raw HTML off, linkify off.
const md = new MarkdownIt('default', { html: false, linkify: false, typographer: false, breaks: false });
md.use(wikiLinks);
md.use(taskLists);

let purifier: DOMPurify | null = null;

function getPurifier(): DOMPurify {
  if (purifier) return purifier;
  const p = createDOMPurify(window);
  p.addHook('afterSanitizeAttributes', (node) => {
    if (node.tagName === 'A') {
      // Browsers drop TAB/LF/CR inside a URL, so classify what they will actually read.
      const href = (node.getAttribute('href') ?? '').replace(/[\t\n\r]/g, '');
      // Only a path on this origin is internal: one leading slash, not `//` or `/\` (browsers read both as another host).
      if (/^(https?:|mailto:)/i.test(href) || href.startsWith('//')) {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
        node.removeAttribute('data-internal');
        node.removeAttribute('data-wikilink');
      } else if (/^\/(?![/\\])/.test(href)) {
        node.setAttribute('data-internal', '1');
        node.removeAttribute('target');
      } else {
        node.removeAttribute('target');
        node.removeAttribute('data-internal');
        node.removeAttribute('data-wikilink');
      }
    } else if (node.tagName === 'INPUT') {
      node.setAttribute('type', 'checkbox');
    }
  });
  purifier = p;
  return p;
}

export function sanitizeHtml(html: string): string {
  return getPurifier().sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_ATTR: ['target', 'data-internal'],
    FORBID_TAGS: ['style', 'form', 'button', 'textarea', 'select', 'iframe', 'object', 'embed'],
    FORBID_ATTR: ['style'],
  });
}

export function renderMarkdown(src: string, env: WikiLinkEnv = {}): string {
  return sanitizeHtml(md.render(src, { ...env }));
}
