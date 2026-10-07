import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const css = readFileSync('src/styles/auth.css', 'utf8');

describe('auth motion css', () => {
  it('fades form errors and notices in', () => {
    expect(css).toContain('.form-error,\n.notice {\n  animation: auth-in');
  });
  it('scopes the ink wipe to html.is-unlocking', () => {
    expect(css).toContain('html.is-unlocking::view-transition-new(root)');
    expect(css).not.toMatch(/^::view-transition/m);
  });
});
