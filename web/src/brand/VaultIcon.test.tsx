// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import { spokeCount, VaultIcon } from './VaultIcon';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let host: HTMLElement | null = null;

function render(level: number, color = '#2dd4bf') {
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<VaultIcon color={color} level={level} />));
  return host;
}

afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  root = host = null;
});

describe('VaultIcon', () => {
  it('draws the outline hexagon, six spokes and the core in the vault colour', () => {
    const el = render(0, '#ff0000');
    const paths = [...el.querySelectorAll('svg > path')];
    expect(paths).toHaveLength(8);
    expect(paths.every((p) => [p.getAttribute('stroke'), p.getAttribute('fill')].includes('#ff0000'))).toBe(true);
  });

  it('lights spokes from the bottom up with the level, and uses no translucency', () => {
    const lit = (level: number) => {
      const el = render(level);
      const idx = [...el.querySelectorAll('.vi-spoke')].map((p, k) => (p.hasAttribute('data-lit') ? k : -1)).filter((k) => k >= 0);
      const opaque = el.querySelectorAll('[opacity], [fill-opacity], [stroke-opacity]').length === 0;
      act(() => root?.unmount());
      host?.remove();
      return { idx, opaque };
    };
    expect(lit(0)).toEqual({ idx: [], opaque: true });
    expect(lit(0.5)).toEqual({ idx: [0, 1, 2], opaque: true });
    expect(lit(1)).toEqual({ idx: [0, 1, 2, 3, 4, 5], opaque: true });
    expect(lit(7).idx).toHaveLength(6);
    expect(lit(Number.NaN).idx).toHaveLength(0);
    expect(spokeCount(1 / 12)).toBe(1);
  });

  it('always has six spokes, the first being the bottom corner', () => {
    const el = render(0);
    const spokes = [...el.querySelectorAll('.vi-spoke')];
    expect(spokes).toHaveLength(6);
    expect(spokes[0].getAttribute('d')).toBe('M12 16.4V21.5');
    expect(spokes.every((p) => p.getAttribute('pathLength') === '1')).toBe(true);
  });

  it('draws spokes in with a stagger and pulses the core only when ink is added, never on mount', () => {
    const el = render(0);
    expect(el.querySelector('.vi-core')!.classList.contains('is-pulse')).toBe(false);
    act(() => root!.render(<VaultIcon color="#2dd4bf" level={0.5} />));
    expect(el.querySelector('.vi-core')!.classList.contains('is-pulse')).toBe(true);
    const delays = [...el.querySelectorAll<SVGPathElement>('.vi-spoke')].map((p) => p.style.transitionDelay);
    expect(delays.slice(0, 3)).toEqual(['0ms', '45ms', '90ms']);
    const key = el.querySelector('.vi-core');
    act(() => root!.render(<VaultIcon color="#2dd4bf" level={0.2} />));
    expect(el.querySelector('.vi-core')).toBe(key);
  });

  it('labels the level for assistive tech', () => {
    expect(render(0.25).querySelector('title')!.textContent).toBe('25% of notes edited this week');
  });
});
