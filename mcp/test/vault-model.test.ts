import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { encryptFolderMeta, encryptNoteBody, encryptNoteMeta, INDEX_TITLE } from 'inked-core';
import { parseConfig, resolvePolicy } from '../src/policy';
import { createCredential, Session } from '../src/session';
import { listAllVaults, VaultModel } from '../src/vault-model';
import { addVault, seedUser, startInked } from './helpers/inked';

const PW = 'correct horse battery';

describe('VaultModel', () => {
  let srv: Awaited<ReturnType<typeof startInked>>;
  let session: Session;
  let work: string;
  let secret: string;
  const ids: Record<string, string> = {};

  beforeAll(async () => {
    srv = await startInked();
    await seedUser(srv.baseUrl, 'jude', PW);
    work = await addVault(srv.baseUrl, 'jude', PW, 'Work');
    secret = await addVault(srv.baseUrl, 'jude', PW, 'Secret');
    session = new Session(await createCredential({ baseUrl: srv.baseUrl, username: 'jude', password: PW }));
    await session.start();
    const { vaults } = await session.api.listVaults();
    const key = await session.vaultKey(vaults.find((v) => v.id === work)!);
    const folder = async (name: string, parentId: string | null) => {
      const id = crypto.randomUUID();
      await session.api.createFolder(work, { id, parentId, encMeta: await encryptFolderMeta(key, work, id, { name }) });
      return id;
    };
    const note = async (title: string, folderId: string | null, body: string) => {
      const id = crypto.randomUUID();
      await session.api.createNote(work, {
        id, folderId,
        encMeta: await encryptNoteMeta(key, work, id, { title }),
        encBody: await encryptNoteBody(key, work, id, body),
      });
      return id;
    };
    ids.projects = await folder('Projects', null);
    ids.inked = await folder('Inked', ids.projects);
    ids.slash = await folder('A/B', null); // made "in the browser": a name with a slash
    ids.dupA = await folder('Dup', null);
    ids.dupB = await folder('Dup', null);
    ids.index = await note(INDEX_TITLE, ids.inked, '# Inked');
    ids.idea = await note('Idea', ids.inked, 'ink flows');
  });
  afterAll(async () => {
    await session.close();
    await srv.close();
  });

  const model = (vaults: '*' | string[]) =>
    listAllVaults(session).then((all) => new VaultModel(session, resolvePolicy(parseConfig({ version: 1, vaults, actions: ['@read'] }), all)));

  it('lists only allowed vaults, with decrypted names', async () => {
    const m = await model(['Work']);
    expect((await m.listVaults()).map((v) => v.name)).toEqual(['Work']);
    await expect(m.vault('Secret')).rejects.toMatchObject({ kind: 'not_found' });
    await expect(m.vault(secret)).rejects.toMatchObject({ kind: 'not_found' });
  });

  it('builds paths and resolves folder refs', async () => {
    const m = await model('*');
    const snap = await m.snapshot(work);
    expect(snap.folders.get(ids.inked)!.path).toBe('Projects/Inked');
    expect(m.resolveFolder(snap, 'Projects/Inked')).toBe(ids.inked);
    expect(m.resolveFolder(snap, ' Projects / Inked ')).toBe(ids.inked);
    expect(m.resolveFolder(snap, ids.inked)).toBe(ids.inked);
    expect(m.resolveFolder(snap, '')).toBeNull();
    expect(m.resolveFolder(snap, null)).toBeNull();
    expect(() => m.resolveFolder(snap, 'Projects/Nope')).toThrow(/not found/);
  });

  it('never resolves a slash-named folder to the wrong folder, but finds it by id', async () => {
    const m = await model('*');
    const snap = await m.snapshot(work);
    expect(snap.folders.get(ids.slash)!.path).toBe('A/B');
    expect(() => m.resolveFolder(snap, 'A/B')).toThrow(/not found/);
    expect(m.resolveFolder(snap, ids.slash)).toBe(ids.slash);
  });

  it('reports ambiguous sibling names with the candidate ids', async () => {
    const m = await model('*');
    const snap = await m.snapshot(work);
    expect(() => m.resolveFolder(snap, 'Dup')).toThrow(new RegExp(`ambiguous.*${ids.dupA}.*${ids.dupB}|ambiguous.*${ids.dupB}.*${ids.dupA}`));
  });

  it('locates notes, reads bodies and marks the Index', async () => {
    const m = await model('*');
    const { snap, note } = await m.locateNote(ids.idea);
    expect(note.title).toBe('Idea');
    expect((await m.readBody(snap, ids.idea)).body).toBe('ink flows');
    expect(m.isIndex(snap, snap.notes.get(ids.index)!)).toBe(true);
    expect(m.isIndex(snap, note)).toBe(false);
    expect((await m.bodies(snap))[ids.idea]).toBe('ink flows');
  });

  it('hides notes in disallowed vaults as not found', async () => {
    const m = await model(['Secret']);
    await expect(m.locateNote(ids.idea)).rejects.toMatchObject({ kind: 'not_found' });
  });
});
