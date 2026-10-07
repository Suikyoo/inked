import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cssRules, cssSelectors } from './cssRules';

// Resolved from this file, not the cwd. (A `?raw` import comes back empty: vitest stubs CSS.)
const css = readFileSync(join(import.meta.dirname, 'auth.css'), 'utf8');

describe('auth motion css', () => {
  it('fades form errors and notices in', () => {
    expect(cssRules(css, '.form-error, .notice')[0]).toMatch(/(^|;)animation:auth-in /);
  });
  it('scopes the ink wipe to html.is-unlocking', () => {
    const selectors = cssSelectors(css);
    expect(selectors).toContain('html.is-unlocking::view-transition-new(root)');
    expect(selectors.filter((s) => s.startsWith('::view-transition'))).toEqual([]);
  });
});
