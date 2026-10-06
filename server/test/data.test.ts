import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, kdfParams, key32, makeApp, setupAdmin, type TestApp } from './helpers.js';

let t: TestApp;
let alice: Account;
let bob: Account;
beforeEach(async () => {
  t = await makeApp();
  alice = await setupAdmin(t.app, 'alice');
  bob = await inviteUser(t.app, alice, 'bob');
});
afterEach(async () => {
  await t.close();
});

const as = (who: Account) => ({
  get: (url: string) => call(t.app, 'GET', url, { cookie: who.cookie }),
  post: (url: string, body: unknown) => call(t.app, 'POST', url, { cookie: who.cookie, body }),
  put: (url: string, body: unknown) => call(t.app, 'PUT', url, { cookie: who.cookie, body }),
  patch: (url: string, body: unknown) => call(t.app, 'PATCH', url, { cookie: who.cookie, body }),
  del: (url: string) => call(t.app, 'DELETE', url, { cookie: who.cookie }),
});

async function createVault(who: Account) {
  const id = randomUUID();
  const res = await as(who).post('/api/vaults', { id, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) });
  expect(res.statusCode).toBe(200);
  return res.json().vault;
}

async function createFolder(who: Account, vaultId: string, parentId: string | null = null) {
  const res = await as(who).post(`/api/vaults/${vaultId}/folders`, { id: randomUUID(), parentId, encMeta: fakeCipher() });
  expect(res.statusCode).toBe(200);
  return res.json().folder;
}

async function createNote(who: Account, vaultId: string, folderId: string | null = null) {
  const res = await as(who).post(`/api/vaults/${vaultId}/notes`, {
    id: randomUUID(),
    folderId,
    encMeta: fakeCipher(),
    encBody: fakeCipher(500),
  });
  expect(res.statusCode).toBe(200);
  return res.json().note;
}

describe('vaults', () => {
  it('create, list, patch, delete', async () => {
    const id = randomUUID();
    const encMeta = fakeCipher();
    const wrappedKey = fakeCipher(60);
    const created = await as(alice).post('/api/vaults', { id, encMeta, wrappedKey });
    expect(created.statusCode).toBe(200);
    const vault = created.json().vault;
    expect(vault).toMatchObject({ id, encMeta, wrappedKey, noteCount: 0, activeNoteCount7d: 0 });
    expect(Date.parse(vault.createdAt)).not.toBeNaN();

    const dup = await as(alice).post('/api/vaults', { id, encMeta, wrappedKey });
    expect(dup.statusCode).toBe(409);

    const list = (await as(alice).get('/api/vaults')).json().vaults;
    expect(list).toEqual([vault]);

    const newMeta = fakeCipher();
    const patched = (await as(alice).patch(`/api/vaults/${id}`, { encMeta: newMeta })).json().vault;
    expect(patched.encMeta).toBe(newMeta);
    expect(Date.parse(patched.updatedAt)).toBeGreaterThan(Date.parse(vault.updatedAt));

    const note = await createNote(alice, id);
    expect((await as(alice).del(`/api/vaults/${id}`)).json()).toEqual({ ok: true });
    expect((await as(alice).get('/api/vaults')).json().vaults).toEqual([]);
    expect((await as(alice).get(`/api/notes/${note.id}`)).statusCode).toBe(404);
  });

  it('counts notes and notes active in the last 7 days', async () => {
    const vault = await createVault(alice);
    const n1 = await createNote(alice, vault.id);
    await createNote(alice, vault.id);
    await createNote(alice, vault.id);
    t.app.db
      .prepare('UPDATE notes SET updated_at = ? WHERE id = ?')
      .run(new Date(Date.now() - 8 * 24 * 3600_000).toISOString(), n1.id);
    const [listed] = (await as(alice).get('/api/vaults')).json().vaults;
    expect(listed.noteCount).toBe(3);
    expect(listed.activeNoteCount7d).toBe(2);
  });

  it('validates input', async () => {
    const bad = [
      { id: 'nope', encMeta: fakeCipher(), wrappedKey: fakeCipher() },
      { id: randomUUID(), encMeta: 'plaintext name', wrappedKey: fakeCipher() },
      { id: randomUUID(), encMeta: 'v1.has+bad/chars=========================================', wrappedKey: fakeCipher() },
      { id: randomUUID(), encMeta: `v1.${'A'.repeat(9000)}`, wrappedKey: fakeCipher() },
      { id: randomUUID(), encMeta: fakeCipher() },
    ];
    for (const body of bad) {
      expect((await as(alice).post('/api/vaults', body)).statusCode).toBe(400);
    }
    expect((await as(alice).get('/api/vaults/not-a-uuid/tree')).statusCode).toBe(400);
  });

  it('requires a session', async () => {
    expect((await call(t.app, 'GET', '/api/vaults')).statusCode).toBe(401);
  });
});

describe('folders', () => {
  it('create nested folders and read the tree', async () => {
    const vault = await createVault(alice);
    const root = await createFolder(alice, vault.id);
    const child = await createFolder(alice, vault.id, root.id);
    const note = await createNote(alice, vault.id, child.id);
    expect(child.parentId).toBe(root.id);

    const tree = (await as(alice).get(`/api/vaults/${vault.id}/tree`)).json();
    expect(tree.folders.map((f: { id: string }) => f.id)).toEqual([root.id, child.id]);
    expect(tree.notes).toEqual([note]);
    expect(tree.notes[0]).not.toHaveProperty('encBody');
  });

  it('rejects a parent from another vault', async () => {
    const v1 = await createVault(alice);
    const v2 = await createVault(alice);
    const f2 = await createFolder(alice, v2.id);
    const res = await as(alice).post(`/api/vaults/${v1.id}/folders`, { id: randomUUID(), parentId: f2.id, encMeta: fakeCipher() });
    expect(res.statusCode).toBe(400);
    const f1 = await createFolder(alice, v1.id);
    expect((await as(alice).patch(`/api/folders/${f1.id}`, { parentId: f2.id })).statusCode).toBe(400);
  });

  it('rejects cycles on move', async () => {
    const vault = await createVault(alice);
    const a = await createFolder(alice, vault.id);
    const b = await createFolder(alice, vault.id, a.id);
    const c = await createFolder(alice, vault.id, b.id);

    for (const parentId of [a.id, b.id, c.id]) {
      const res = await as(alice).patch(`/api/folders/${a.id}`, { parentId });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toBe('cycle');
    }

    // Legal moves: c to the root, then a under c.
    expect((await as(alice).patch(`/api/folders/${c.id}`, { parentId: null })).json().folder.parentId).toBeNull();
    const moved = await as(alice).patch(`/api/folders/${a.id}`, { parentId: c.id });
    expect(moved.statusCode).toBe(200);
    expect(moved.json().folder.parentId).toBe(c.id);
  });

  it('renames without moving', async () => {
    const vault = await createVault(alice);
    const a = await createFolder(alice, vault.id);
    const b = await createFolder(alice, vault.id, a.id);
    const encMeta = fakeCipher();
    const res = (await as(alice).patch(`/api/folders/${b.id}`, { encMeta })).json().folder;
    expect(res).toMatchObject({ id: b.id, parentId: a.id, encMeta });
  });

  it('deletes the folder subtree and its notes', async () => {
    const vault = await createVault(alice);
    const a = await createFolder(alice, vault.id);
    const b = await createFolder(alice, vault.id, a.id);
    const keep = await createFolder(alice, vault.id);
    const inB = await createNote(alice, vault.id, b.id);
    const inKeep = await createNote(alice, vault.id, keep.id);

    expect((await as(alice).del(`/api/folders/${a.id}`)).json()).toEqual({ ok: true });
    const tree = (await as(alice).get(`/api/vaults/${vault.id}/tree`)).json();
    expect(tree.folders.map((f: { id: string }) => f.id)).toEqual([keep.id]);
    expect(tree.notes.map((n: { id: string }) => n.id)).toEqual([inKeep.id]);
    expect((await as(alice).get(`/api/notes/${inB.id}`)).statusCode).toBe(404);
  });
});

describe('notes', () => {
  it('create, read, update, delete', async () => {
    const vault = await createVault(alice);
    const folder = await createFolder(alice, vault.id);
    const id = randomUUID();
    const encBody = fakeCipher(1000);
    const created = await as(alice).post(`/api/vaults/${vault.id}/notes`, { id, folderId: null, encMeta: fakeCipher(), encBody });
    const head = created.json().note;
    expect(head).toMatchObject({ id, folderId: null, size: encBody.length });
    expect(head).not.toHaveProperty('encBody');

    const read = (await as(alice).get(`/api/notes/${id}`)).json().note;
    expect(read).toEqual({ ...head, encBody });

    const newBody = fakeCipher(28);
    const updated = (await as(alice).put(`/api/notes/${id}`, { encBody: newBody, folderId: folder.id })).json().note;
    expect(updated).toMatchObject({ id, folderId: folder.id, size: newBody.length, encMeta: head.encMeta });
    expect(Date.parse(updated.updatedAt)).toBeGreaterThan(Date.parse(head.updatedAt));

    const bodies = (await as(alice).get(`/api/vaults/${vault.id}/bodies`)).json();
    expect(bodies).toEqual({ notes: [{ id, encBody: newBody, updatedAt: updated.updatedAt }] });

    expect((await as(alice).del(`/api/notes/${id}`)).json()).toEqual({ ok: true });
    expect((await as(alice).get(`/api/notes/${id}`)).statusCode).toBe(404);
  });

  it('rejects a folder from another vault', async () => {
    const v1 = await createVault(alice);
    const v2 = await createVault(alice);
    const f2 = await createFolder(alice, v2.id);
    const res = await as(alice).post(`/api/vaults/${v1.id}/notes`, { id: randomUUID(), folderId: f2.id, encMeta: fakeCipher(), encBody: fakeCipher() });
    expect(res.statusCode).toBe(400);
  });

  it('returns 409 when baseUpdatedAt is older than the stored version', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);

    const first = await as(alice).put(`/api/notes/${note.id}`, { encBody: fakeCipher(), baseUpdatedAt: note.updatedAt });
    expect(first.statusCode).toBe(200);

    // A second editor still holding the original version.
    const stale = await as(alice).put(`/api/notes/${note.id}`, { encBody: fakeCipher(), baseUpdatedAt: note.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error).toBe('conflict');

    const fresh = await as(alice).put(`/api/notes/${note.id}`, {
      encBody: fakeCipher(),
      baseUpdatedAt: first.json().note.updatedAt,
    });
    expect(fresh.statusCode).toBe(200);

    // Without baseUpdatedAt the write is unconditional.
    expect((await as(alice).put(`/api/notes/${note.id}`, { encMeta: fakeCipher() })).statusCode).toBe(200);
  });

  it('enforces the encBody size limit', async () => {
    const vault = await createVault(alice);
    const tooBig = `v1.${'A'.repeat(2 * 1024 * 1024)}`;
    const res = await as(alice).post(`/api/vaults/${vault.id}/notes`, { id: randomUUID(), folderId: null, encMeta: fakeCipher(), encBody: tooBig });
    expect(res.statusCode).toBe(413);

    const huge = await as(alice).post(`/api/vaults/${vault.id}/notes`, {
      id: randomUUID(),
      folderId: null,
      encMeta: fakeCipher(),
      encBody: `v1.${'A'.repeat(5 * 1024 * 1024)}`,
    });
    expect(huge.statusCode).toBe(413);
    expect(huge.json().error).toBe('too_large');
  });
});

describe('isolation between users', () => {
  it("returns 404 for another user's vaults, folders and notes", async () => {
    const vault = await createVault(alice);
    const folder = await createFolder(alice, vault.id);
    const note = await createNote(alice, vault.id, folder.id);
    const b = as(bob);

    expect((await b.get('/api/vaults')).json().vaults).toEqual([]);
    const attempts = [
      b.get(`/api/vaults/${vault.id}/tree`),
      b.get(`/api/vaults/${vault.id}/bodies`),
      b.patch(`/api/vaults/${vault.id}`, { encMeta: fakeCipher() }),
      b.del(`/api/vaults/${vault.id}`),
      b.post(`/api/vaults/${vault.id}/folders`, { id: randomUUID(), parentId: null, encMeta: fakeCipher() }),
      b.post(`/api/vaults/${vault.id}/notes`, { id: randomUUID(), folderId: null, encMeta: fakeCipher(), encBody: fakeCipher() }),
      b.patch(`/api/folders/${folder.id}`, { encMeta: fakeCipher() }),
      b.del(`/api/folders/${folder.id}`),
      b.get(`/api/notes/${note.id}`),
      b.put(`/api/notes/${note.id}`, { encBody: fakeCipher() }),
      b.del(`/api/notes/${note.id}`),
    ];
    for (const res of await Promise.all(attempts)) {
      expect(res.statusCode, `${res.raw.req.method} ${res.raw.req.url}`).toBe(404);
      expect(res.json()).toEqual({ error: 'not_found' });
    }

    // Bob cannot reparent his own folder or note into Alice's folder either.
    const bobVault = await createVault(bob);
    const bobFolder = await createFolder(bob, bobVault.id);
    const bobNote = await createNote(bob, bobVault.id);
    expect((await b.patch(`/api/folders/${bobFolder.id}`, { parentId: folder.id })).statusCode).toBe(400);
    expect((await b.put(`/api/notes/${bobNote.id}`, { folderId: folder.id })).statusCode).toBe(400);

    // Alice's data is untouched.
    const a = (await as(alice).get(`/api/notes/${note.id}`)).json().note;
    expect(a.encBody).toBe((await as(alice).get(`/api/vaults/${vault.id}/bodies`)).json().notes[0].encBody);
    expect((await as(alice).get(`/api/vaults/${vault.id}/tree`)).json().folders).toHaveLength(1);
  });
});

describe('note size limit', () => {
  it('oversized note body returns 413 too_large (M10)', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    // ~2.1 MB of valid ciphertext characters, under the 4 MB request limit
    const huge = `v1.${'A'.repeat(2_100_000)}`;
    const r = await as(alice).put(`/api/notes/${note.id}`, { encBody: huge });
    expect(r.statusCode).toBe(413);
    expect(r.json().error).toBe('too_large');
  });
});

describe('X-Inked-User binds a data request to the expected account', () => {
  /** `who`'s session, claiming to act for `claimed`. */
  const claiming = (who: Account, claimed: string | null) => {
    const headers: Record<string, string> = claimed === null ? {} : { 'x-inked-user': claimed };
    return {
      get: (url: string) => call(t.app, 'GET', url, { cookie: who.cookie, headers }),
      post: (url: string, body: unknown) => call(t.app, 'POST', url, { cookie: who.cookie, body, headers }),
      put: (url: string, body: unknown) => call(t.app, 'PUT', url, { cookie: who.cookie, body, headers }),
      patch: (url: string, body: unknown) => call(t.app, 'PATCH', url, { cookie: who.cookie, body, headers }),
      del: (url: string) => call(t.app, 'DELETE', url, { cookie: who.cookie, headers }),
    };
  };

  it('answers 409 user_mismatch on every data route when the header names someone else, before any lookup', async () => {
    const vault = await createVault(alice);
    const folder = await createFolder(alice, vault.id);
    const note = await createNote(alice, vault.id);
    const invite = (await as(alice).post('/api/invites', {})).json();
    expect(invite.token).toBeTruthy();
    const invitesBefore = (await as(alice).get('/api/invites')).json().invites;
    const inviteId = invitesBefore.at(-1).id;
    // Alice's session, but the tab still thinks it is bob (or the reverse): nothing is read or written.
    const wrong = claiming(alice, bob.userId);
    const responses = [
      await wrong.get('/api/vaults'),
      await wrong.post('/api/vaults', { id: randomUUID(), encMeta: fakeCipher(), wrappedKey: fakeCipher(60) }),
      await wrong.patch(`/api/vaults/${vault.id}`, { encMeta: fakeCipher() }),
      await wrong.get(`/api/vaults/${vault.id}/tree`),
      await wrong.get(`/api/vaults/${vault.id}/bodies`),
      await wrong.post(`/api/vaults/${vault.id}/folders`, { id: randomUUID(), parentId: null, encMeta: fakeCipher() }),
      await wrong.patch(`/api/folders/${folder.id}`, { encMeta: fakeCipher() }),
      await wrong.post(`/api/vaults/${vault.id}/notes`, { id: randomUUID(), folderId: null, encMeta: fakeCipher(), encBody: fakeCipher() }),
      await wrong.get(`/api/notes/${note.id}`),
      await wrong.put(`/api/notes/${note.id}`, { encBody: fakeCipher() }),
      await wrong.del(`/api/notes/${note.id}`),
      await wrong.del(`/api/folders/${folder.id}`),
      await wrong.del(`/api/vaults/${vault.id}`),
      await wrong.get('/api/invites'),
      await wrong.post('/api/invites', {}),
      await wrong.del(`/api/invites/${inviteId}`),
      // Bob's session naming alice, on alice's note: still the mismatch, not a 404.
      await claiming(bob, alice.userId).put(`/api/notes/${note.id}`, { encBody: fakeCipher() }),
      // Checked before validation too.
      await wrong.get('/api/vaults/not-a-uuid/tree'),
    ];
    for (const r of responses) {
      expect([r.statusCode, r.json()]).toEqual([409, { error: 'user_mismatch' }]);
    }
    // Nothing changed.
    const read = (await as(alice).get(`/api/notes/${note.id}`)).json().note;
    expect(read.updatedAt).toBe(note.updatedAt);
    expect((await as(alice).get('/api/vaults')).json().vaults).toHaveLength(1);
    expect((await as(alice).get('/api/invites')).json().invites).toEqual(invitesBefore);
  });

  it('a matching header passes', async () => {
    const vault = await createVault(alice);
    const note = await createNote(alice, vault.id);
    const right = claiming(alice, alice.userId);
    expect((await right.get('/api/vaults')).statusCode).toBe(200);
    expect((await right.get(`/api/notes/${note.id}`)).statusCode).toBe(200);
    const put = await right.put(`/api/notes/${note.id}`, { encBody: fakeCipher(), baseUpdatedAt: note.updatedAt });
    expect(put.statusCode).toBe(200);
    expect((await right.get('/api/invites')).statusCode).toBe(200);
    // Another account's note under a matching header is still simply not found.
    expect((await claiming(bob, bob.userId).get(`/api/notes/${note.id}`)).statusCode).toBe(404);
  });

  it('an absent header passes (older clients)', async () => {
    const vault = await createVault(alice);
    const none = claiming(alice, null);
    expect((await none.get('/api/vaults')).statusCode).toBe(200);
    expect((await none.get(`/api/vaults/${vault.id}/tree`)).statusCode).toBe(200);
    expect((await none.get('/api/invites')).statusCode).toBe(200);
  });

  it('without a session the answer is still 401, header or not', async () => {
    const r = await call(t.app, 'GET', '/api/vaults', { headers: { 'x-inked-user': alice.userId } });
    expect(r.statusCode).toBe(401);
  });

  it('the auth routes ignore the header', async () => {
    const headers = { 'x-inked-user': bob.userId };
    const me = await call(t.app, 'GET', '/api/me', { cookie: alice.cookie, headers });
    expect(me.statusCode).toBe(200);
    expect(me.json().user.id).toBe(alice.userId);
    expect((await call(t.app, 'GET', '/api/status', { headers })).statusCode).toBe(200);
    expect((await call(t.app, 'GET', '/api/auth/params?username=alice', { headers })).statusCode).toBe(200);
    // The proof is checked as usual (403), not the header (409).
    const pw = await call(t.app, 'POST', '/api/auth/password', {
      cookie: alice.cookie,
      headers,
      body: { currentAuthKey: key32(), kdfSalt: randomBytes(16).toString('base64url'), kdfParams, authKey: key32(), wrappedUserKey: fakeCipher(60) },
    });
    expect(pw.statusCode).toBe(403);
    const rk = await call(t.app, 'POST', '/api/auth/recovery-key', {
      cookie: alice.cookie,
      headers,
      body: { currentAuthKey: key32(), recoveryAuth: key32(), wrappedUserKeyRecovery: fakeCipher(60) },
    });
    expect(rk.statusCode).toBe(403);
    const login = await call(t.app, 'POST', '/api/auth/login', { headers, body: { username: 'bob', authKey: bob.authKey } });
    expect(login.statusCode).toBe(200);
    expect((await call(t.app, 'POST', '/api/auth/logout', { cookie: alice.cookie, headers })).statusCode).toBe(200);
  });
});
