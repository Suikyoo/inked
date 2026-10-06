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
