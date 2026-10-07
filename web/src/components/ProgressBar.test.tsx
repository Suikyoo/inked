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
});
