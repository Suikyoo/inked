// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { describe, expect, it } from 'vitest';
import { ProgressBar } from './ProgressBar';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('ProgressBar', () => {
  it('exposes value and max and shows its label', () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<ProgressBar value={142} max={210} label="Work · 142 / 210 notes" />));
    const bar = host.querySelector('[role="progressbar"]')!;
    expect(bar.getAttribute('aria-label')).toBe('Work · 142 / 210 notes');
    expect(bar.getAttribute('aria-valuenow')).toBe('142');
    expect(bar.getAttribute('aria-valuemin')).toBe('0');
    expect(bar.getAttribute('aria-valuemax')).toBe('210');
    expect(host.querySelector('.progress-label')?.textContent).toBe('Work · 142 / 210 notes');
    expect((bar.firstElementChild as HTMLElement).style.width).toBe(`${(142 / 210) * 100}%`);
    act(() => root.unmount());
    host.remove();
  });

  const bar = (value: number, max: number) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    act(() => root.render(<ProgressBar value={value} max={max} label="x" />));
    const el = host.querySelector('[role="progressbar"]')!;
    const out = { now: el.getAttribute('aria-valuenow'), max: el.getAttribute('aria-valuemax'), width: (el.firstElementChild as HTMLElement).style.width };
    act(() => root.unmount());
    host.remove();
    return out;
  };

  it('keeps aria-valuenow within range when max is 0', () => {
    expect(bar(5, 0)).toEqual({ now: '0', max: '0', width: '0%' });
  });

  it('clamps a value above max', () => {
    expect(bar(300, 210)).toEqual({ now: '210', max: '210', width: '100%' });
  });

  it('treats NaN as 0', () => {
    expect(bar(NaN, 10).now).toBe('0');
  });
});
