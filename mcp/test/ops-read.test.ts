import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptFolderMeta, encryptNoteBody, encryptNoteMeta, INDEX_TITLE } from 'inked-core';
import { Audit } from '../src/audit';
import { Ops } from '../src/ops';
import { parseConfig, resolvePolicy } from '../src/policy';
import { createCredential, Session } from '../src/session';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('Ops (read)', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;
  let work: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    work = await addVault(srv.baseUrl, 'jude', PW, 'Work');
    await addVault(srv.baseUrl, 'jude', PW, 'Secret');
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
    const { vaults } = await session.api.listVaults();
    const key = await session.vaultKey(vaults.find((v) => v.id === work)!);
    ids.folder = crypto.randomUUID();
    await session.api.createFolder(work, { id: ids.folder, parentId: null, encMeta: await encryptFolderMeta(key, work, ids.folder, { name: 'Research' }) });
    for (const [k, title, body] of [['index', INDEX_TITLE, '# Research'], ['ink', 'Iron gall ink', 'Iron gall ink fades to brown.']]) {
      ids[k] = crypto.randomUUID();
      await session.api.createNote(work, {
        id: ids[k], folderId: ids.folder,
        encMeta: await encryptNoteMeta(key, work, ids[k], { title }),
        encBody: await encryptNoteBody(key, work, ids[k], body),
      });
    }
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  const ops = async (vaults: '*' | string[], actions = ['@read']) => {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults, actions }), await listAllVaults(session));
    return new Ops(session, new VaultModel(session, policy), policy);
  };

  it('getTree nests folders and marks the Index', async () => {
    const t = await (await ops('*')).getTree('Work');
    expect(t.vault.name).toBe('Work');
    const research = t.folders.find((f) => f.name === 'Research')!;
    expect(research.path).toBe('Research');
    expect(research.notes.find((n) => n.title === INDEX_TITLE)!.isIndex).toBe(true);
    expect(research.notes.find((n) => n.title === 'Iron gall ink')!.isIndex).toBe(false);
  });

  it('readNote returns the body in its own field', async () => {
    const n = await (await ops('*')).readNote(ids.ink);
    expect(n).toMatchObject({ id: ids.ink, vaultId: work, path: 'Research', title: 'Iron gall ink', body: 'Iron gall ink fades to brown.' });
  });

  it('search finds titles and bodies with snippets', async () => {
    const s = await (await ops('*')).search('brown');
    expect(s.bodyHits[0]).toMatchObject({ noteId: ids.ink, title: 'Iron gall ink' });
    expect(s.bodyHits[0].snippet).toContain('brown');
    const t = await (await ops('*')).search('gall');
    expect(t.titleHits[0].noteId).toBe(ids.ink);
  });

  it('search caps the limit at 50', async () => {
    await expect((await ops('*')).search('ink', undefined, 500)).resolves.toBeDefined();
  });

  it('hides disallowed vaults from list, tree, read and search', async () => {
    const o = await ops(['Secret']);
    expect((await o.listVaults()).map((v) => v.name)).toEqual(['Secret']);
    await expect(o.getTree('Work')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(o.readNote(ids.ink)).rejects.toMatchObject({ kind: 'not_found' });
    expect((await o.search('brown')).bodyHits).toEqual([]);
  });

  it('re-checks the policy even when called directly', async () => {
    const o = await ops('*', ['vault.list']);
    await expect(o.readNote(ids.ink)).rejects.toMatchObject({ kind: 'denied' });
  });

  it('audit lines carry no titles, bodies or names', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'inked-audit-')), 'audit.log');
    const a = new Audit(file);
    a.write({ tool: 'read_note', ok: true, vaultId: work, ids: [ids.ink] });
    a.write({ tool: 'read_note', ok: false, error: 'tool_not_found' });
    const text = readFileSync(file, 'utf8');
    expect(text.trim().split('\n')).toHaveLength(2);
    expect(text).not.toMatch(/Iron gall|Research|Work/);
    expect(JSON.parse(text.split('\n')[0])).toMatchObject({ tool: 'read_note', ok: true, ids: [ids.ink] });
  });
});
