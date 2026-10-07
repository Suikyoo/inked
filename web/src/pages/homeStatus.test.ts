import { describe, expect, it } from 'vitest';
import { homeColumn, homeError, homePending } from './homeStatus';

type S = Parameters<typeof homePending>[0];
const state = (vaultsStatus: S['vaultsStatus'], trees: S['trees'] = {}, vaultOrder: string[] = Object.keys(trees)): S => ({ vaultsStatus, trees, vaultOrder });
const t = (status: 'loading' | 'ready' | 'error') => ({ status, folders: {}, notes: {} });

describe('homePending', () => {
  it('is not pending after a load error', () => {
    expect(homePending(state('error'))).toBe(false);
  });
  it('is pending while the vault list is idle or loading', () => {
    expect(homePending(state('idle'))).toBe(true);
    expect(homePending(state('loading'))).toBe(true);
  });
  it('is pending when ready but a tree is still loading', () => {
    expect(homePending(state('ready', { a: t('ready'), b: t('loading') }))).toBe(true);
  });
  it('is not pending when ready and every tree has settled', () => {
    expect(homePending(state('ready', { a: t('ready'), b: t('error') }))).toBe(false);
    expect(homePending(state('ready'))).toBe(false);
  });
});

describe('homeError', () => {
  it('is true when the vault load failed and nothing is loaded', () => {
    expect(homeError(state('error'))).toBe(true);
  });
  it('is false when a refresh failed but vaults are still loaded', () => {
    expect(homeError(state('error', { a: t('ready') }))).toBe(false);
  });
  it('is false when ready', () => {
    expect(homeError(state('ready'))).toBe(false);
    expect(homeError(state('ready', { a: t('ready') }))).toBe(false);
  });
});

describe('homeColumn', () => {
  const note = { id: 'n1', vaultId: 'v1', folderId: null, title: 'A', size: 0, createdAt: '', updatedAt: '' };
  const s = {
    vaults: { v1: { id: 'v1' } },
    trees: { v1: { status: 'ready', folders: { f1: { id: 'f1' } }, notes: { n1: note } } },
  } as unknown as Parameters<typeof homeColumn>[0];
  const sel = { kind: 'note', vaultId: 'v1', id: 'n1' } as const;
  it('a non-empty query is search, even with a selection', () => {
    expect(homeColumn(s, 'abc', sel)).toBe('search');
  });
  it('a selection with no query is preview', () => {
    expect(homeColumn(s, '', sel)).toBe('preview');
    expect(homeColumn(s, '', { kind: 'folder', vaultId: 'v1', id: 'f1' })).toBe('preview');
    expect(homeColumn(s, '', { kind: 'hub', vaultId: 'v1' })).toBe('preview');
  });
  it('neither is empty', () => {
    expect(homeColumn(s, '', null)).toBe('empty');
  });
  it('a selection that no longer exists is empty', () => {
    expect(homeColumn(s, '', { kind: 'note', vaultId: 'v1', id: 'gone' })).toBe('empty');
    expect(homeColumn({ ...s, trees: {} }, '', sel)).toBe('empty');
    expect(homeColumn({ ...s, vaults: {} }, '', { kind: 'hub', vaultId: 'v1' })).toBe('empty');
    expect(homeColumn({ ...s, trees: {} }, '', { kind: 'hub', vaultId: 'v1' })).toBe('empty');
  });
});
