import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { nowIso, type NoteVectorRow } from '../db.js';
import { ApiError } from '../errors.js';
import { encVec, idParams, modelName } from '../schemas.js';
import { ownedNote, ownedVault } from './access.js';

type IdParams = { Params: { id: string } };
interface PutBody {
  model: string;
  encVec: string;
  sourceUpdatedAt: string;
}

const putSchema = {
  params: idParams,
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['model', 'encVec', 'sourceUpdatedAt'],
    properties: { model: modelName, encVec, sourceUpdatedAt: { type: 'string', maxLength: 64 } },
  },
} as const;

export function vectorRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };

  app.get<IdParams>('/api/vaults/:id/vectors', { ...auth, schema: { params: idParams } }, async (request) => {
    const vault = ownedVault(db, currentUser(request).id, request.params.id);
    const rows = db
      .prepare('SELECT note_id, model, enc_vec, source_updated_at FROM note_vectors WHERE vault_id = ? ORDER BY note_id')
      .all(vault.id) as unknown as Pick<NoteVectorRow, 'note_id' | 'model' | 'enc_vec' | 'source_updated_at'>[];
    return {
      vectors: rows.map((r) => ({ noteId: r.note_id, model: r.model, encVec: r.enc_vec, sourceUpdatedAt: r.source_updated_at })),
    };
  });

  app.put<IdParams & { Body: PutBody }>('/api/notes/:id/vector', { ...auth, schema: putSchema }, async (request) => {
    const note = ownedNote(db, currentUser(request).id, request.params.id);
    const { model, encVec: ct, sourceUpdatedAt } = request.body;
    const source = Date.parse(sourceUpdatedAt);
    if (Number.isNaN(source)) throw new ApiError(400, 'invalid_request', 'sourceUpdatedAt must be an ISO-8601 timestamp');
    if (source > Date.parse(note.updated_at)) throw new ApiError(422, 'stale', 'The vector is newer than the note');
    db.prepare(
      `INSERT INTO note_vectors (note_id, vault_id, model, enc_vec, source_updated_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(note_id) DO UPDATE SET model = excluded.model, enc_vec = excluded.enc_vec,
         source_updated_at = excluded.source_updated_at, updated_at = excluded.updated_at
         WHERE excluded.source_updated_at >= note_vectors.source_updated_at`,
    ).run(note.id, note.vault_id, model, ct, new Date(source).toISOString(), nowIso());
    return { ok: true };
  });
}
