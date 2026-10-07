import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decryptNoteBody, INDEX_TITLE } from 'inked-core';
import { appendJoin, Ops } from '../src/ops';
import { parseConfig, resolvePolicy } from '../src/policy';
import { WriteLimiter } from '../src/ratelimit';
import { createCredential, Session } from '../src/session';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';
const ALL = ['@read', '@write', '@organize'];

describe('appendJoin', () => {
  it.each([
    ['', 'new', 'new'],
    ['old', 'new', 'old\nnew'],
    ['old\n', 'new', 'old\nnew'],
    ['old\n\n', 'new', 'old\n\nnew'],
  ])('%j + %j → %j', (body, text, out) => expect(appendJoin(body, text)).toBe(out));
});

describe('Ops (write)', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;
  let work: string;

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    work = await addVault(srv.baseUrl, 'jude', PW, 'Work');
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  const ops = async (actions = ALL, limiter?: WriteLimiter) => {
    const policy = resolvePolicy(parseConfig({ version: 1, vaults: '*', actions }), await listAllVaults(session));
    return new Ops(session, new VaultModel(session, policy), policy, limiter);
  };

  it('create_folder creates the folder and its Index note, readable with core decrypt', async () => {
    const o = await ops();
    const { folder, indexNoteId } = await o.createFolder('Work', null, 'Ink');
    expect(folder.path).toBe('Ink');
    const idx = await o.readNote(indexNoteId!);
    expect(idx.title).toBe(INDEX_TITLE);
    expect(idx.body).toBe('# Ink\n\nDescribe what lives in this folder.\n');
    // Format compatibility: the web client's decrypt (same core code) reads what the MCP wrote.
    const { vaults } = await session.api.listVaults();
    const key = await session.vaultKey(vaults.find((v) => v.id === work)!);
    const { note } = await session.api.getNote(indexNoteId!);
    expect(await decryptNoteBody(key, work, indexNoteId!, note.encBody)).toBe(idx.body);
  });

  it('rejects folder names with "/" and empty names', async () => {
    const o = await ops();
    await expect(o.createFolder('Work', null, 'A/B')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(o.createFolder('Work', null, '   ')).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('create_note, append, update with conflict detection', async () => {
    const o = await ops();
    await o.createFolder('Work', null, 'Notes');
    const n = await o.createNote('Work', 'Notes', 'Draft', 'one');
    const appended = await o.appendToNote(n.id, 'two');
    expect((await o.readNote(n.id)).body).toBe('one\ntwo');
    await expect(o.updateNote(n.id, n.updatedAt, { body: 'stale write' })).rejects.toMatchObject({ kind: 'conflict' });
    const updated = await o.updateNote(n.id, appended.updatedAt, { title: 'Final', body: 'done' });
    expect(updated.title).toBe('Final');
    expect((await o.readNote(n.id)).body).toBe('done');
    await expect(o.updateNote(n.id, updated.updatedAt, {})).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('create_notes validates first, writes in order, and stops at the first failure', async () => {
    const o = await ops();
    await o.createFolder('Work', null, 'Batch');
    await expect(o.createNotes('Work', [{ folder: 'Batch', title: 'a', body: '' }, { folder: 'Nope', title: 'b', body: '' }]))
      .rejects.toMatchObject({ kind: 'not_found' });
    expect((await o.getTree('Work')).folders.find((f) => f.name === 'Batch')!.notes.map((n) => n.title)).toEqual([INDEX_TITLE]);

    const huge = 'x'.repeat(2_100_000); // over the server's body limit once encrypted
    const res = await o.createNotes('Work', [
      { folder: 'Batch', title: 'first', body: '1' },
      { folder: 'Batch', title: 'second', body: '2' },
      { folder: 'Batch', title: 'too big', body: huge },
      { folder: 'Batch', title: 'never', body: '4' },
    ]);
    expect(res.created.map((n) => n.title)).toEqual(['first', 'second']);
    expect(res.failed).toEqual({ index: 2, error: 'Note is too large (about 1.5 MB of text is the limit).' });
  });

  it('create_notes refuses 0 or more than 50 items', async () => {
    const o = await ops();
    await expect(o.createNotes('Work', [])).rejects.toMatchObject({ kind: 'invalid' });
    const many = Array.from({ length: 51 }, (_, i) => ({ folder: null, title: `n${i}`, body: '' }));
    await expect(o.createNotes('Work', many)).rejects.toMatchObject({ kind: 'invalid' });
  });

  it('rate limit: a batch that does not fit writes nothing; the 121st single write is refused', async () => {
    let t = 0;
    const o = await ops(ALL, new WriteLimiter(120, () => t));
    const before = (await o.getTree('Work')).notes.length;
    const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ folder: null, title: `r${t}-${i}`, body: '' }));
    await o.createNotes('Work', batch(50));
    await o.createNotes('Work', batch(50));
    await expect(o.createNotes('Work', batch(21))).rejects.toMatchObject({ kind: 'rate_limited' });
    expect((await o.getTree('Work')).notes.length).toBe(before + 100);
    for (let i = 0; i < 20; i++) await o.createNote('Work', null, `single${i}`, '');
    await expect(o.createNote('Work', null, 'the 121st', '')).rejects.toMatchObject({ kind: 'rate_limited' });
    t = 61_000;
    await expect(o.createNote('Work', null, 'after the window', '')).resolves.toBeDefined();
  });

  it('move_note, rename_folder, move_folder with cycle refusal', async () => {
    const o = await ops();
    const a = (await o.createFolder('Work', null, 'Alpha')).folder;
    const b = (await o.createFolder('Work', 'Alpha', 'Beta')).folder;
    const n = await o.createNote('Work', null, 'Loose', '');
    expect((await o.moveNote(n.id, 'Alpha/Beta')).path).toBe('Alpha/Beta');
    expect((await o.renameFolder(b.id, 'Gamma')).path).toBe('Alpha/Gamma');
    await expect(o.renameFolder(b.id, 'x/y')).rejects.toMatchObject({ kind: 'invalid' });
    await expect(o.moveFolder(a.id, b.id)).rejects.toMatchObject({ kind: 'invalid' });
    await expect(o.moveFolder(a.id, a.id)).rejects.toMatchObject({ kind: 'invalid' });
    expect((await o.moveFolder(b.id, null)).path).toBe('Gamma');
  });

  it('write actions are denied without the grant', async () => {
    const o = await ops(['@read', 'note.append']);
    await expect(o.createNote('Work', null, 'x', '')).rejects.toMatchObject({ kind: 'denied' });
    await expect(o.createFolder('Work', null, 'x')).rejects.toMatchObject({ kind: 'denied' });
  });
});
