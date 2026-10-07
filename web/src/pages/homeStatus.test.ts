import { describe, expect, it } from 'vitest';
import { homePending } from './homeStatus';

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
