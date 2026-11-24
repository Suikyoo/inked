import { describe, expect, it } from 'vitest';
import { applyKeymaps, clearKeymaps, indentStringFor, optionExtensions, type VimApi } from './applyVim';

/** Records every call made to the vim engine, in order, so the tests assert on sequence as well as content. */
function spy(): VimApi & { calls: string[][] } {
  const calls: string[][] = [];
  return {
    calls,
    map: (lhs, rhs, ctx) => calls.push(['map', lhs, rhs, ctx]),
    noremap: (lhs, rhs, ctx) => calls.push(['noremap', lhs, rhs, ctx]),
    mapclear: (ctx) => calls.push(['mapclear', ctx ?? '']),
  };
}

describe('applyKeymaps', () => {
  it('clears each context before applying, and maps in order', () => {
    const api = spy();
    applyKeymaps(api, [
      { modes: ['n', 'v'], lhs: 'H', rhs: '^', remap: false },
      { modes: ['i'], lhs: 'jk', rhs: '<Esc>', remap: true },
    ]);
    expect(api.calls).toEqual([
      ['mapclear', 'normal'],
      ['mapclear', 'insert'],
      ['mapclear', 'visual'],
      ['noremap', 'H', '^', 'normal'],
      ['noremap', 'H', '^', 'visual'],
      ['map', 'jk', '<Esc>', 'insert'],
    ]);
  });

  it('replaces rather than appends when reapplied', () => {
    const api = spy();
    applyKeymaps(api, [{ modes: ['n'], lhs: 'a', rhs: 'b', remap: false }]);
    api.calls.length = 0;
    applyKeymaps(api, [{ modes: ['n'], lhs: 'c', rhs: 'd', remap: false }]);
    expect(api.calls.filter((c) => c[0] === 'mapclear')).toHaveLength(3);
    expect(api.calls).toContainEqual(['noremap', 'c', 'd', 'normal']);
  });
});

describe('clearKeymaps', () => {
  it('clears all three contexts and maps nothing', () => {
    const api = spy();
    clearKeymaps(api);
    expect(api.calls).toEqual([
      ['mapclear', 'normal'],
      ['mapclear', 'insert'],
      ['mapclear', 'visual'],
    ]);
  });
});

describe('optionExtensions', () => {
  it('builds no extensions for an empty option set', () => {
    expect(optionExtensions({})).toEqual([]);
  });

  it('builds extensions for the options it is given', () => {
    expect(optionExtensions({ number: true, wrap: true })).toHaveLength(2);
  });
});


describe('indentStringFor', () => {
  it('indents with vim’s own default tabstop of 8 when none is given', () => {
    expect(indentStringFor({ expandtab: true })).toBe(' '.repeat(8));
  });

  it('indents with the configured tabstop', () => {
    expect(indentStringFor({ expandtab: true, tabstop: 4 })).toBe('    ');
  });

  it('indents with a tab when expandtab is off', () => {
    expect(indentStringFor({ expandtab: false, tabstop: 4 })).toBe('\t');
  });
});
