// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { followNoteLink, type LinkClick } from './NotePane';

function link(attrs: Record<string, string>) {
  const a = document.createElement('a');
  for (const [k, v] of Object.entries(attrs)) a.setAttribute(k, v);
  const span = document.createElement('span');
  span.textContent = 'label';
  a.appendChild(span);
  return span; // clicks usually land on the link's text
}

function click(target: Element, mods: Partial<LinkClick> = {}): LinkClick {
  return {
    target,
    button: 0,
    ctrlKey: false,
    metaKey: false,
    shiftKey: false,
    altKey: false,
    preventDefault: vi.fn(),
    ...mods,
  };
}

const internal = () => link({ href: '/v/v1/n/n2', 'data-internal': '1' });
const wiki = () => link({ href: '/v/v1/n/n3', 'data-wikilink': '' });

describe('followNoteLink (B4)', () => {
  it('routes a plain left click on an internal or wiki link through the router', () => {
    for (const [target, to] of [
      [internal(), '/v/v1/n/n2'],
      [wiki(), '/v/v1/n/n3'],
    ] as const) {
      const navigate = vi.fn();
      const e = click(target);
      followNoteLink(e, navigate);
      expect(e.preventDefault).toHaveBeenCalledTimes(1);
      expect(navigate).toHaveBeenCalledWith(to);
    }
  });

  it('leaves modified and non-primary clicks to the browser (new tab, new window, download)', () => {
    const variants: Partial<LinkClick>[] = [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }];
    for (const target of [internal(), wiki()]) {
      for (const mods of variants) {
        const navigate = vi.fn();
        const e = click(target, mods);
        followNoteLink(e, navigate);
        expect([mods, (e.preventDefault as ReturnType<typeof vi.fn>).mock.calls.length]).toEqual([mods, 0]);
        expect(navigate).not.toHaveBeenCalled();
      }
    }
  });

  it('ignores external links and clicks outside links', () => {
    const navigate = vi.fn();
    for (const target of [link({ href: 'https://example.com', target: '_blank' }), document.createElement('p')]) {
      const e = click(target);
      followNoteLink(e, navigate);
      expect(e.preventDefault).not.toHaveBeenCalled();
    }
    expect(navigate).not.toHaveBeenCalled();
  });
});
