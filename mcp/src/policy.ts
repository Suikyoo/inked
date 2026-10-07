import { existsSync, readFileSync } from 'node:fs';
import { configPath } from './home';

export const ACTIONS = [
  'vault.list', 'tree.read', 'note.read', 'search',
  'folder.create', 'note.create', 'note.append', 'note.update',
  'note.move', 'folder.rename', 'folder.move',
] as const;
export type Action = (typeof ACTIONS)[number];

export const GROUPS: Readonly<Record<string, readonly Action[]>> = {
  '@read': ['vault.list', 'tree.read', 'note.read', 'search'],
  '@write': ['folder.create', 'note.create', 'note.append', 'note.update'],
  '@organize': ['note.move', 'folder.rename', 'folder.move'],
};

export const WRITE_ACTIONS: ReadonlySet<Action> = new Set([...GROUPS['@write'], ...GROUPS['@organize']]);

export const DEFAULT_WRITES_PER_MINUTE = 120;

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export interface ParsedConfig {
  vaults: '*' | string[];
  actions: ReadonlySet<Action>;
  writesPerMinute: number;
}

const isAction = (s: string): s is Action => (ACTIONS as readonly string[]).includes(s);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Validates a config strictly: a typo must stop the server, never change access silently. */
export function parseConfig(raw: unknown): ParsedConfig {
  if (!isObj(raw)) throw new ConfigError('Config must be a JSON object');
  for (const k of Object.keys(raw)) {
    if (!['version', 'vaults', 'actions', 'limits'].includes(k)) throw new ConfigError(`Unknown config key "${k}"`);
  }
  if (raw.version !== 1) throw new ConfigError('Config "version" must be 1');

  let vaults: '*' | string[];
  if (raw.vaults === '*') vaults = '*';
  else if (Array.isArray(raw.vaults) && raw.vaults.length > 0 && raw.vaults.every((v) => typeof v === 'string' && v.trim() !== '')) {
    vaults = raw.vaults as string[];
  } else throw new ConfigError('Config "vaults" must be "*" or a non-empty list of vault names or ids');

  if (!Array.isArray(raw.actions) || raw.actions.length === 0) {
    throw new ConfigError('Config "actions" must be a non-empty list');
  }
  const actions = new Set<Action>();
  for (const a of raw.actions) {
    if (typeof a !== 'string') throw new ConfigError('Config "actions" must contain strings');
    if (a in GROUPS) GROUPS[a].forEach((x) => actions.add(x));
    else if (isAction(a)) actions.add(a);
    else throw new ConfigError(`Unknown action "${a}"`);
  }

  let writesPerMinute = DEFAULT_WRITES_PER_MINUTE;
  if (raw.limits !== undefined) {
    if (!isObj(raw.limits)) throw new ConfigError('Config "limits" must be an object');
    for (const k of Object.keys(raw.limits)) {
      if (k !== 'writesPerMinute') throw new ConfigError(`Unknown limits key "${k}"`);
    }
    const w = raw.limits.writesPerMinute;
    if (w !== undefined) {
      if (typeof w !== 'number' || !Number.isInteger(w) || w < 1 || w > 1000) {
        throw new ConfigError('"limits.writesPerMinute" must be an integer from 1 to 1000');
      }
      writesPerMinute = w;
    }
  }
  return { vaults, actions, writesPerMinute };
}

/** With no `file`, a missing default config means read-only access to every vault. */
export function loadConfig(file?: string): ParsedConfig {
  const target = file ?? configPath();
  if (!existsSync(target)) {
    if (file) throw new ConfigError(`Config file not found: ${file}`);
    return parseConfig({ version: 1, vaults: '*', actions: ['@read'] });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(target, 'utf8'));
  } catch {
    throw new ConfigError(`Config file is not valid JSON: ${target}`);
  }
  return parseConfig(raw);
}

export interface Policy {
  readonly actions: ReadonlySet<Action>;
  readonly writesPerMinute: number;
  readonly allVaults: boolean;
  readonly vaultIds: ReadonlySet<string>;
  allows(action: Action, vaultId?: string): boolean;
  vaultAllowed(vaultId: string): boolean;
}

/** Resolves vault names to ids once the names are decrypted. Unknown or ambiguous names are errors. */
export function resolvePolicy(cfg: ParsedConfig, vaults: { id: string; name: string }[]): Policy {
  const ids = new Set<string>();
  if (cfg.vaults !== '*') {
    for (const ref of cfg.vaults) {
      if (vaults.some((v) => v.id === ref)) {
        ids.add(ref);
        continue;
      }
      const named = vaults.filter((v) => v.name === ref);
      if (named.length === 0) throw new ConfigError(`Vault "${ref}" not found`);
      if (named.length > 1) {
        throw new ConfigError(`Vault name "${ref}" matches ${named.length} vaults; use an id: ${named.map((v) => v.id).join(', ')}`);
      }
      ids.add(named[0].id);
    }
  }
  const allVaults = cfg.vaults === '*';
  const vaultAllowed = (vaultId: string) => allVaults || ids.has(vaultId);
  return {
    actions: cfg.actions,
    writesPerMinute: cfg.writesPerMinute,
    allVaults,
    vaultIds: ids,
    vaultAllowed,
    allows: (action, vaultId) => cfg.actions.has(action) && (vaultId === undefined || vaultAllowed(vaultId)),
  };
}
