import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Account, call, fakeCipher, inviteUser, makeApp, setupAdmin, type TestApp } from './helpers.js';

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
  del: (url: string) => call(t.app, 'DELETE', url, { cookie: who.cookie }),
});

async function vaultWithNote(who: Account) {
  const vaultId = randomUUID();
  expect((await as(who).post('/api/vaults', { id: vaultId, encMeta: fakeCipher(), wrappedKey: fakeCipher(60) })).statusCode).toBe(200);
  const noteId = randomUUID();
  const res = await as(who).post(`/api/vaults/${vaultId}/notes`, { id: noteId, folderId: null, encMeta: fakeCipher(), encBody: fakeCipher() });
  return { vaultId, noteId, updatedAt: res.json().note.updatedAt as string };
}

describe('note vectors', () => {
  it('stores, lists and replaces a vector without touching the note', async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    const body = { model: 'bge-small-en-v1.5@abcd1234', encVec: fakeCipher(1600), sourceUpdatedAt: updatedAt };
    expect((await as(alice).put(`/api/notes/${noteId}/vector`, body)).statusCode).toBe(200);
    const again = { ...body, encVec: fakeCipher(1600) };
    expect((await as(alice).put(`/api/notes/${noteId}/vector`, again)).statusCode).toBe(200);
    const list = (await as(alice).get(`/api/vaults/${vaultId}/vectors`)).json().vectors;
    expect(list).toEqual([{ noteId, model: body.model, encVec: again.encVec, sourceUpdatedAt: updatedAt }]);
    const note = (await as(alice).get(`/api/notes/${noteId}`)).json().note;
    expect(note.updatedAt).toBe(updatedAt);
  });
  it('keeps the newer vector when an older write arrives late', async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    const older = new Date(Date.parse(updatedAt) - 60_000).toISOString();
    const newer = { model: 'm', encVec: fakeCipher(1600), sourceUpdatedAt: updatedAt };
    expect((await as(alice).put(`/api/notes/${noteId}/vector`, newer)).statusCode).toBe(200);
    const late = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(1600), sourceUpdatedAt: older });
    expect(late.statusCode).toBe(200);
    expect(late.json()).toEqual({ ok: true });
    const list = (await as(alice).get(`/api/vaults/${vaultId}/vectors`)).json().vectors;
    expect(list).toEqual([{ noteId, model: 'm', encVec: newer.encVec, sourceUpdatedAt: updatedAt }]);
  });
  it('answers 422 for a sourceUpdatedAt newer than the note and 400 for a bad date', async () => {
    const { noteId } = await vaultWithNote(alice);
    const future = new Date(Date.now() + 60_000).toISOString();
    const r = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: future });
    expect(r.statusCode).toBe(422);
    expect(r.json().error).toBe('stale');
    const bad = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: 'nope' });
    expect(bad.statusCode).toBe(400);
  });
  it('validates the model name and size', async () => {
    const { noteId, updatedAt } = await vaultWithNote(alice);
    const badModel = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'a b', encVec: fakeCipher(), sourceUpdatedAt: updatedAt });
    expect(badModel.statusCode).toBe(400);
    const huge = await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(8000), sourceUpdatedAt: updatedAt });
    expect(huge.statusCode).toBe(400);
  });
  it("keeps users apart: 404 for another user's note or vault", async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    expect((await as(bob).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: updatedAt })).statusCode).toBe(404);
    expect((await as(bob).get(`/api/vaults/${vaultId}/vectors`)).statusCode).toBe(404);
  });
  it('deletes vectors with their note and their vault', async () => {
    const { vaultId, noteId, updatedAt } = await vaultWithNote(alice);
    await as(alice).put(`/api/notes/${noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: updatedAt });
    await as(alice).del(`/api/notes/${noteId}`);
    expect((await as(alice).get(`/api/vaults/${vaultId}/vectors`)).json().vectors).toEqual([]);
    const other = await vaultWithNote(alice);
    await as(alice).put(`/api/notes/${other.noteId}/vector`, { model: 'm', encVec: fakeCipher(), sourceUpdatedAt: other.updatedAt });
    expect((await as(alice).del(`/api/vaults/${other.vaultId}`)).statusCode).toBe(200);
    const left = t.app.db.prepare('SELECT COUNT(*) AS n FROM note_vectors').get() as { n: number };
    expect(left.n).toBe(0);
  });
  it('requires a session', async () => {
    expect((await call(t.app, 'GET', `/api/vaults/${randomUUID()}/vectors`)).statusCode).toBe(401);
  });
});

describe('model files', () => {
  it('serves models with immutable caching, the manifest with no-cache, and 404 when missing', async () => {
    const web = path.join(t.dataDir, 'web');
    mkdirSync(path.join(web, 'models', 'abcd1234'), { recursive: true });
    writeFileSync(path.join(web, 'index.html'), '<!doctype html>');
    writeFileSync(path.join(web, 'models', 'manifest.json'), '{"model":"m"}');
    writeFileSync(path.join(web, 'models', 'abcd1234', 'config.json'), '{}');
    const s = await makeApp({ webDist: web });
    try {
      const m = await call(s.app, 'GET', '/models/manifest.json');
      expect(m.statusCode).toBe(200);
      expect(m.headers['cache-control']).toBe('no-cache');
      const f = await call(s.app, 'GET', '/models/abcd1234/config.json');
      expect(f.headers['cache-control']).toBe('public, max-age=31536000, immutable');
      const missing = await call(s.app, 'GET', '/models/nope.json');
      expect(missing.statusCode).toBe(404);
      expect(missing.headers['content-type']).toMatch(/json/);
      // Spellings that normalise to /models/... must still get the JSON 404, never the SPA shell.
      for (const url of ['/%6Dodels/nope.json', '/models', '/models/?x=1', '/models/../models/nope.json']) {
        const r = await call(s.app, 'GET', url);
        expect(r.statusCode, url).toBe(404);
        expect(r.headers['content-type'], url).toMatch(/json/);
        expect(r.body, url).not.toContain('<!doctype html>');
      }
      // A doubled leading slash is rejected or routed, but must never come back as the SPA HTML with 200.
      const doubled = await call(s.app, 'GET', '//models/nope.json');
      expect(doubled.body).not.toContain('<!doctype html>');
      expect(doubled.statusCode === 200 && /html/.test(String(doubled.headers['content-type']))).toBe(false);
    } finally {
      await s.close();
    }
  });
});
