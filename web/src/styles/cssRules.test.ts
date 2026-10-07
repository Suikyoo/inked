import { describe, expect, it } from 'vitest';
import { cssRules, cssSelectors } from './cssRules';

describe('cssRules', () => {
  const sheet = [
    '/* a comment { with braces } */',
    '.form-error,',
    '.notice {',
    '  animation:   auth-in var(--dur-3)   var(--ease-out) both;',
    '}',
    '@media (prefers-reduced-motion: reduce) {',
    '  .form-error, .notice { animation-duration: 120ms; }',
    '}',
    '',
  ].join('\n');

  it('reads the same rules from LF and CRLF text, whatever the spacing', () => {
    const lf = cssRules(sheet, '.form-error, .notice');
    expect(lf).toEqual(['animation:auth-in var(--dur-3) var(--ease-out) both;', 'animation-duration:120ms;']);
    expect(cssRules(sheet.replace(/\n/g, '\r\n'), '.form-error,.notice')).toEqual(lf);
  });

  it('lists selectors part by part, comments ignored', () => {
    expect(cssSelectors(sheet)).toEqual(['.form-error', '.notice', '.form-error', '.notice']);
  });
});
