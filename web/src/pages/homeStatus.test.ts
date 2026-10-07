import { describe, expect, it } from 'vitest';
import { homeError, homePending } from './homeStatus';

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
