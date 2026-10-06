// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { renderMarkdown, sanitizeHtml, toggleTaskAtLine, wikiLinkTargets } from './render';

const dom = (html: string) => {
  const d = document.createElement('div');
  d.innerHTML = html;
  return d;
};

describe('sanitizer', () => {
  it('strips <script>, javascript: links and event handlers from raw HTML', () => {
    const out = sanitizeHtml(
      '<p>ok</p><script>alert(1)</script><a href="javascript:alert(1)">x</a><img src="x" onerror="alert(1)">' +
        '<svg><script>alert(2)</script></svg><div onclick="alert(3)">y</div>',
    );
    expect(out).not.toMatch(/<script/i);
    expect(out).not.toMatch(/javascript:/i);
    expect(out).not.toMatch(/onerror|onclick/i);
    expect(out).toContain('<p>ok</p>');
  });

  it('never emits raw HTML from Markdown source', () => {
    const out = renderMarkdown('hi <script>alert(1)</script> <img src=x onerror=alert(1)>');
    expect(dom(out).querySelector('script')).toBeNull();
    expect(dom(out).querySelector('img')).toBeNull();
    expect(out).not.toMatch(/<script/i);
  });

  it('does not render javascript: or data:text links', () => {
    const out = renderMarkdown('[a](javascript:alert(1)) [b](JAVASCRIPT:alert(1)) [c](data:text/html,<b>x</b>)');
    expect(out).not.toMatch(/href="javascript:/i);
    expect(out).not.toMatch(/href="data:text/i);
    expect(dom(out).querySelectorAll('a[href]')).toHaveLength(0);
  });

  it('opens external links in a new tab without referrer', () => {
    const a = dom(renderMarkdown('[site](https://example.com)')).querySelector('a')!;
    expect(a.getAttribute('target')).toBe('_blank');
    expect(a.getAttribute('rel')).toBe('noopener noreferrer');
  });
});

describe('markdown features', () => {
  it('renders GFM tables, strikethrough and fenced code', () => {
    const d = dom(renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |\n\n~~old~~\n\n```bash\necho hi\n```\n'));
    expect(d.querySelector('table td')?.textContent).toBe('1');
    expect(d.querySelector('s')?.textContent).toBe('old');
    expect(d.querySelector('pre code.language-bash')?.textContent).toBe('echo hi\n');
  });

  it('does not linkify bare URLs', () => {
    expect(dom(renderMarkdown('see https://example.com')).querySelector('a')).toBeNull();
  });

  it('renders task lists with source lines', () => {
    const d = dom(renderMarkdown('intro\n\n- [x] done\n- [ ] todo\n- not a task\n'));
    const boxes = d.querySelectorAll<HTMLInputElement>('input.task-checkbox');
    expect(boxes).toHaveLength(2);
    expect(boxes[0].checked).toBe(true);
    expect(boxes[0].dataset.line).toBe('2');
    expect(boxes[1].checked).toBe(false);
    expect(boxes[1].dataset.line).toBe('3');
    expect(d.querySelector('ul')?.className).toContain('contains-task-list');
    expect(d.querySelectorAll('li.task-list-item')).toHaveLength(2);
    expect(d.querySelector('li.task-list-item')?.textContent).toBe('done');
  });

  it('toggles a task in the source', () => {
    const src = 'a\n\n- [x] done\n- [ ] todo\n> - [ ] quoted';
    expect(toggleTaskAtLine(src, 3)).toBe('a\n\n- [x] done\n- [x] todo\n> - [ ] quoted');
    expect(toggleTaskAtLine(src, 2)).toBe('a\n\n- [ ] done\n- [ ] todo\n> - [ ] quoted');
    expect(toggleTaskAtLine(src, 4)).toBe('a\n\n- [x] done\n- [ ] todo\n> - [x] quoted');
    expect(toggleTaskAtLine(src, 0)).toBeNull();
  });

  it('resolves wiki links and mutes unresolved ones', () => {
    const titles: Record<string, string> = { 'deploy-prod': '/v/v1/n/n1' };
    const out = renderMarkdown('See [[Deploy-Prod]], [[deploy-prod|the runbook]] and [[missing note]]. [[ ]]', {
      resolveWikiLink: (t) => titles[t.toLowerCase()] ?? null,
    });
    const d = dom(out);
    const links = d.querySelectorAll('a.wl');
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute('href')).toBe('/v/v1/n/n1');
    expect(links[0].textContent).toBe('Deploy-Prod');
    expect(links[1].textContent).toBe('the runbook');
    expect(d.querySelector('.wl-missing')?.textContent).toBe('missing note');
    expect(d.textContent).toContain('[[ ]]');
  });

  it('escapes wiki link labels', () => {
    const out = renderMarkdown('[[<img src=x onerror=alert(1)>]]');
    expect(dom(out).querySelector('img')).toBeNull();
  });

  it('extracts wiki-link targets', () => {
    expect([...wikiLinkTargets('[[A]] and [[b c|label]] and `[[C]]`')]).toEqual(['a', 'b c', 'c']);
  });
});

describe('internal links', () => {
  it('marks same-origin links internal so the router handles them (M9)', () => {
    const html = renderMarkdown('[a](/v/123) [b](https://example.com) [c](//evil.example)');
    expect(html).toContain('href="/v/123" data-internal="1"');
    expect(html).toContain('target="_blank"');
    expect(html).not.toMatch(/href="\/\/evil\.example"[^>]*data-internal/);
  });
});
