import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, parseConfig, resolvePolicy } from '../src/policy';

const vaults = [
  { id: 'v-work', name: 'Work' },
  { id: 'v-home', name: 'Personal' },
  { id: 'v-dup1', name: 'Dup' },
  { id: 'v-dup2', name: 'Dup' },
];

describe('parseConfig', () => {
  it('expands groups', () => {
    const c = parseConfig({ version: 1, vaults: '*', actions: ['@read', 'note.append'] });
    expect([...c.actions].sort()).toEqual(['note.append', 'note.read', 'search', 'tree.read', 'vault.list']);
    expect(c.writesPerMinute).toBe(120);
  });

  it('expands every group to the exact grantable set', () => {
    const c = parseConfig({ version: 1, vaults: '*', actions: ['@read', '@write', '@organize'] });
    expect([...c.actions].sort()).toEqual([
      'folder.create', 'folder.move', 'folder.rename', 'note.append', 'note.create',
      'note.move', 'note.read', 'note.update', 'search', 'tree.read', 'vault.list',
    ]);
  });

  it.each([
    [{ version: 2, vaults: '*', actions: ['@read'] }, /version/],
    [{ version: 1, vaults: '*', actions: ['note.delete'] }, /Unknown action "note.delete"/],
    [{ version: 1, vaults: '*', actions: ['@everything'] }, /Unknown action "@everything"/],
    [{ version: 1, vaults: '*', actions: [] }, /actions/],
    [{ version: 1, vaults: [], actions: ['@read'] }, /vaults/],
    [{ version: 1, vaults: '*', actions: ['@read'], extra: true }, /Unknown config key "extra"/],
    [{ version: 1, vaults: '*', actions: ['@read'], limits: { writesPerMinute: 0 } }, /writesPerMinute/],
    [{ version: 1, vaults: '*', actions: ['@read'], limits: { burst: 5 } }, /Unknown limits key "burst"/],
    ['not an object', /object/],
  ])('rejects %j', (raw, msg) => {
    expect(() => parseConfig(raw)).toThrow(ConfigError);
    expect(() => parseConfig(raw)).toThrow(msg);
  });
});

describe('loadConfig', () => {
  const dir = () => mkdtempSync(path.join(tmpdir(), 'inked-mcp-cfg-'));

  it('defaults to @read on all vaults when the default file is missing', () => {
    process.env.INKED_MCP_HOME = dir();
    const c = loadConfig();
    expect(c.vaults).toBe('*');
    expect([...c.actions].sort()).toEqual(['note.read', 'search', 'tree.read', 'vault.list']);
  });

  it('fails when an explicitly named file is missing', () => {
    expect(() => loadConfig(path.join(dir(), 'nope.json'))).toThrow(/not found/);
  });

  it('fails on invalid JSON', () => {
    const f = path.join(dir(), 'c.json');
    writeFileSync(f, '{ nope');
    expect(() => loadConfig(f)).toThrow(/not valid JSON/);
  });
});

describe('resolvePolicy', () => {
  it('allows every vault for "*"', () => {
    const p = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions: ['@read'] }), vaults);
    expect(p.allVaults).toBe(true);
    expect(p.allows('note.read', 'v-anything')).toBe(true);
    expect(p.allows('note.create', 'v-work')).toBe(false);
  });

  it('resolves names and ids', () => {
    const p = resolvePolicy(parseConfig({ version: 1, vaults: ['Work', 'v-home'], actions: ['@read'] }), vaults);
    expect(p.vaultAllowed('v-work')).toBe(true);
    expect(p.vaultAllowed('v-home')).toBe(true);
    expect(p.vaultAllowed('v-dup1')).toBe(false);
  });

  it('rejects an unknown vault name', () => {
    const cfg = parseConfig({ version: 1, vaults: ['Nope'], actions: ['@read'] });
    expect(() => resolvePolicy(cfg, vaults)).toThrow(/Vault "Nope" not found/);
  });

  it('rejects an ambiguous vault name and lists the ids', () => {
    const cfg = parseConfig({ version: 1, vaults: ['Dup'], actions: ['@read'] });
    expect(() => resolvePolicy(cfg, vaults)).toThrow(/matches 2 vaults.*v-dup1.*v-dup2/);
  });
});
