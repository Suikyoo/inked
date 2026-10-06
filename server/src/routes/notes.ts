import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { bumpTimestamp, nowIso } from '../db.js';
import { ApiError } from '../errors.js';
import { encBody, encMeta, idParams, nullableUuid, uuid } from '../schemas.js';
import { folderInVault, noteHeadJson, ownedNote, ownedVault } from './access.js';

const createSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'folderId', 'encMeta', 'encBody'],
    properties: { id: uuid, folderId: nullableUuid, encMeta, encBody },
  },
} as const;

const updateSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    properties: { encMeta, encBody, folderId: nullableUuid, baseUpdatedAt: { type: 'string', maxLength: 64 } },
  },
} as const;

type IdParams = { Params: { id: string } };

interface UpdateBody {
  encMeta?: string;
  encBody?: string;
  folderId?: string | null;
  baseUpdatedAt?: string;
}

export function noteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.post<IdParams & { Body: { id: string; folderId: string | null; encMeta: string; encBody: string } }>(
    '/api/vaults/:id/notes',
    { ...auth, schema: createSchema },
    async (request) => {
      const userId = currentUser(request).id;
      const vault = ownedVault(db, userId, request.params.id);
      const { id, folderId, encMeta: meta, encBody: body } = request.body;
      if (folderId !== null && !folderInVault(db, vault.id, folderId)) throw new ApiError(400, 'invalid_folder');
      if (db.prepare('SELECT 1 FROM notes WHERE id = ?').get(id)) throw new ApiError(409, 'exists');
      const now = nowIso();
      db.prepare(
        `INSERT INTO notes (id, vault_id, folder_id, enc_meta, enc_body, size, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(id, vault.id, folderId, meta, body, body.length, now, now);
      return { note: noteHeadJson(ownedNote(db, userId, id)) };
    },
  );

  app.get<IdParams>('/api/notes/:id', { ...auth, schema: { params: idParams } }, async (request) => {
    const note = ownedNote(db, currentUser(request).id, request.params.id);
    return { note: { ...noteHeadJson(note), encBody: note.enc_body } };
  });

  app.put<IdParams & { Body: UpdateBody }>('/api/notes/:id', { ...auth, schema: updateSchema }, async (request) => {
    const userId = currentUser(request).id;
    const note = ownedNote(db, userId, request.params.id);
    const { encMeta: meta, encBody: body, folderId, baseUpdatedAt } = request.body;

    if (baseUpdatedAt !== undefined) {
      const base = Date.parse(baseUpdatedAt);
      if (Number.isNaN(base)) throw new ApiError(400, 'invalid_request', 'baseUpdatedAt must be an ISO-8601 timestamp');
      if (base < Date.parse(note.updated_at)) {
        throw new ApiError(409, 'conflict', 'The note was changed since baseUpdatedAt');
      }
    }
    if (folderId !== undefined && folderId !== null && !folderInVault(db, note.vault_id, folderId)) {
      throw new ApiError(400, 'invalid_folder');
    }
    if (meta === undefined && body === undefined && folderId === undefined) {
      return { note: noteHeadJson(note) };
    }

    const newBody = body ?? note.enc_body;
    db.prepare(
      'UPDATE notes SET enc_meta = ?, enc_body = ?, size = ?, folder_id = ?, updated_at = ? WHERE id = ?',
    ).run(
      meta ?? note.enc_meta,
      newBody,
      newBody.length,
      folderId === undefined ? note.folder_id : folderId,
      bumpTimestamp(note.updated_at),
      note.id,
    );
    return { note: noteHeadJson(ownedNote(db, userId, note.id)) };
  });

  app.delete<IdParams>('/api/notes/:id', { ...auth, schema: { params: idParams } }, async (request) => {
    const note = ownedNote(db, currentUser(request).id, request.params.id);
    db.prepare('DELETE FROM notes WHERE id = ?').run(note.id);
    return { ok: true };
  });
}
