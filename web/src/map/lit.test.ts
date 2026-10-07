import { describe, expect, it } from 'vitest';
import { litSet, mapFocus } from './lit';
import type { Scene } from './scene';

describe('mapFocus', () => {
  const base = { hover: null, keyboard: null, hot: null, selectedNote: null, searching: false };
  it('prefers hover, then keyboard, then hot, then the selection', () => {
    expect(mapFocus({ ...base, hover: 'h', keyboard: 'k', hot: 't', selectedNote: 's' })).toBe('h');
    expect(mapFocus({ ...base, keyboard: 'k', hot: 't', selectedNote: 's' })).toBe('k');
    expect(mapFocus({ ...base, hot: 't', selectedNote: 's' })).toBe('t');
    expect(mapFocus({ ...base, selectedNote: 's' })).toBe('s');
    expect(mapFocus(base)).toBeNull();
  });
  it('uses the selection only while searching', () => {
    expect(mapFocus({ ...base, hover: 'h', keyboard: 'k', hot: 't', selectedNote: 's', searching: true })).toBe('s');
    expect(mapFocus({ ...base, hover: 'h', searching: true })).toBeNull();
  });
});

const seg = (id: string, a: string, b: string) => ({ id, a, b, x1: 0, y1: 0, x2: 1, y2: 1 });
const scene: Scene = {
  dots: [],
  folders: [],
  hubs: [],
  pencil: [],
  links: [seg('a-b', 'a', 'b'), seg('c-a', 'c', 'a')],
  linksPending: false,
  bounds: { minX: 0, minY: 0, maxX: 0, maxY: 0 },
  vaultBounds: {},
  folderBounds: {},
  chains: {},
  chainFolders: { a: ['f1'], b: ['f2'], c: [], d: ['f3'] },
  rootIndexes: {},
};

describe('litSet', () => {
  it('lights the focus, its link neighbours, meaning neighbours and their folders', () => {
    const lit = litSet('a', scene, ['d']);
    expect([...lit.notes].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect([...lit.folders].sort()).toEqual(['f1', 'f2', 'f3']);
    expect(lit.links.map((l) => l.id)).toEqual(['a-b', 'c-a']);
  });
  it('leaves out notes that only touch a neighbour', () => {
    const lit = litSet('b', scene, []);
    expect([...lit.notes].sort()).toEqual(['a', 'b']);
    expect([...lit.folders].sort()).toEqual(['f1', 'f2']);
    expect(lit.links).toHaveLength(1);
  });
  it('is empty with no focus', () => {
    const lit = litSet(null, scene, ['d']);
    expect(lit.notes.size).toBe(0);
    expect(lit.folders.size).toBe(0);
    expect(lit.links).toHaveLength(0);
  });
});
