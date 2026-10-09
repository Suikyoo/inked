// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest';
import { prefs } from './prefs';

describe('prefs.spellcheck', () => {
  beforeEach(() => localStorage.clear());
  it('defaults to off (M7)', () => expect(prefs.spellcheck()).toBe(false));
  it('persists', () => {
    prefs.setSpellcheck(true);
    expect(prefs.spellcheck()).toBe(true);
  });
});

describe('prefs.semanticChoice', () => {
  beforeEach(() => localStorage.clear());
  it('is unset by default and persists on and off', () => {
    expect(prefs.semanticChoice()).toBeNull();
    prefs.setSemanticChoice('on');
    expect(prefs.semanticChoice()).toBe('on');
    prefs.setSemanticChoice('off');
    expect(prefs.semanticChoice()).toBe('off');
    prefs.setSemanticChoice(null);
    expect(prefs.semanticChoice()).toBeNull();
  });
  it('reads the round-4 values: 1 is on, 0 is unset', () => {
    localStorage.setItem('inked.semantic', '1');
    expect(prefs.semanticChoice()).toBe('on');
    localStorage.setItem('inked.semantic', '0');
    expect(prefs.semanticChoice()).toBeNull();
  });
});
