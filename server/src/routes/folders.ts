import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { bumpTimestamp, type Db, nowIso } from '../db.js';
import { ApiError } from '../errors.js';
import { encMeta, idParams, nullableUuid, uuid } from '../schemas.js';
import { folderInVault, folderJson, ownedFolder, ownedVault } from './access.js';

const createSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'parentId', 'encMeta'],
    properties: { id: uuid, parentId: nullableUuid, encMeta },
  },
} as const;

const patchSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { encMeta, parentId: nullableUuid },
  },
} as const;

type IdParams = { Params: { id: string } };

/** True when `candidateId` is `folderId` itself or one of its descendants. */
function isSelfOrDescendant(db: Db, folderId: string, candidateId: string): boolean {
  const row = db
    .prepare(
      `WITH RECURSIVE ancestors(id) AS (
         SELECT ?
         UNION
         SELECT f.parent_id FROM folders f JOIN ancestors a ON f.id = a.id WHERE f.parent_id IS NOT NULL
       )
       SELECT 1 FROM ancestors WHERE id = ?`,
    )
    .get(candidateId, folderId);
  return row !== undefined;
}

export function folderRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.post<IdParams & { Body: { id: string; parentId: string | null; encMeta: string } }>(
    '/api/vaults/:id/folders',
    { ...auth, schema: createSchema },
    async (request) => {
      const vault = ownedVault(db, currentUser(request).id, request.params.id);
      const { id, parentId, encMeta: meta } = request.body;
      if (parentId !== null && !folderInVault(db, vault.id, parentId)) throw new ApiError(400, 'invalid_parent');
      if (db.prepare('SELECT 1 FROM folders WHERE id = ?').get(id)) throw new ApiError(409, 'exists');
      const now = nowIso();
      db.prepare(
        'INSERT INTO folders (id, vault_id, parent_id, enc_meta, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(id, vault.id, parentId, meta, now, now);
      return { folder: folderJson(ownedFolder(db, currentUser(request).id, id)) };
    },
  );

  app.patch<IdParams & { Body: { encMeta?: string; parentId?: string | null } }>(
    '/api/folders/:id',
    { ...auth, schema: patchSchema },
    async (request) => {
      const userId = currentUser(request).id;
      const folder = ownedFolder(db, userId, request.params.id);
      const { encMeta: meta, parentId } = request.body;

      if (parentId !== undefined && parentId !== null) {
        if (!folderInVault(db, folder.vault_id, parentId)) throw new ApiError(400, 'invalid_parent');
        // Moving a folder under itself or one of its descendants would create a cycle.
        if (isSelfOrDescendant(db, folder.id, parentId)) throw new ApiError(400, 'cycle');
      }

      db.prepare('UPDATE folders SET enc_meta = ?, parent_id = ?, updated_at = ? WHERE id = ?').run(
        meta ?? folder.enc_meta,
        parentId === undefined ? folder.parent_id : parentId,
        bumpTimestamp(folder.updated_at),
        folder.id,
      );
      return { folder: folderJson(ownedFolder(db, userId, folder.id)) };
    },
  );

  // Subfolders and their notes go with it via ON DELETE CASCADE.
  app.delete<IdParams>('/api/folders/:id', { ...auth, schema: { params: idParams } }, async (request) => {
    const folder = ownedFolder(db, currentUser(request).id, request.params.id);
    db.prepare('DELETE FROM folders WHERE id = ?').run(folder.id);
    return { ok: true };
  });
}
