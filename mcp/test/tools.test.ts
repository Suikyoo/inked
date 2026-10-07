import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Audit } from '../src/audit';
import { Ops } from '../src/ops';
import { parseConfig, resolvePolicy } from '../src/policy';
import { createCredential, Session } from '../src/session';
import { buildInstructions, createInkedServer, TOOL_NAMES } from '../src/tools';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('MCP tools', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    await addVault(srv.baseUrl, 'jude', PW, 'Work');
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  async function connect(actions: string[]) {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions }), await listAllVaults(session));
    const ops = new Ops(session, new VaultModel(session, policy), policy);
    const audit = new Audit(path.join(mkdtempSync(path.join(tmpdir(), 'inked-tools-')), 'audit.log'));
    const { server } = createInkedServer({ ops, policy, audit, version: 'test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '0' });
    await Promise.all([server.connect(a), client.connect(b)]);
    return client;
  }

  it('registers only granted tools, and none that deletes, under any config', async () => {
    const ro = await connect(['@read']);
    expect((await ro.listTools()).tools.map((t) => t.name).sort()).toEqual(['get_tree', 'list_vaults', 'read_note', 'search']);
    const all = await connect(['@read', '@write', '@organize']);
    const names = (await all.listTools()).tools.map((t) => t.name);
    expect(names.sort()).toEqual([...TOOL_NAMES].sort());
    expect(names.some((n) => /delete|remove|destroy|vault_(create|rename)/.test(n))).toBe(false);
  });

  it('instructions mention only registered tools', async () => {
    const ro = await connect(['@read']);
    const text = ro.getInstructions() ?? '';
    expect(text).toContain('list_vaults');
    expect(text).not.toMatch(/append_to_note|update_note|create_notes/);
    expect(buildInstructions(TOOL_NAMES)).toMatch(/append_to_note/);
  });

  it('never names a tool that is not registered, in instructions or descriptions', async () => {
    for (const actions of [['@write'], ['note.create'], ['@organize'], ['@read'], ['note.update'], ['@read', '@write', '@organize']]) {
      const c = await connect(actions);
      const tools = (await c.listTools()).tools;
      const registered = tools.map((t) => t.name);
      const text = [c.getInstructions() ?? '', ...tools.map((t) => t.description ?? '')].join('\n');
      for (const n of TOOL_NAMES) {
        if (new RegExp(`\\b${n}\\b`).test(text)) expect(registered, `${actions} names ${n}`).toContain(n);
      }
    }
  });

  it('round-trips a write and returns errors as isError results', async () => {
    const c = await connect(['@read', '@write']);
    const made = await c.callTool({ name: 'create_folder', arguments: { vault: 'Work', parent: null, name: 'Topic' } });
    expect(made.isError).toBeFalsy();
    const bad = await c.callTool({ name: 'create_folder', arguments: { vault: 'Work', parent: null, name: 'a/b' } });
    expect(bad.isError).toBe(true);
    expect((bad.content as { text: string }[])[0].text).toBe('Folder names must not contain "/".');
    const tree = await c.callTool({ name: 'get_tree', arguments: { vault: 'Work' } });
    expect(JSON.parse((tree.content as { text: string }[])[0].text).folders[0].name).toBe('Topic');
  });
});
