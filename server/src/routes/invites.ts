import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireAdmin } from '../context.js';
import { randomToken, sha256Hex } from '../crypto.js';
import { nowIso } from '../db.js';
import { notFound } from '../errors.js';
import { idParams } from '../schemas.js';

const DEFAULT_EXPIRY_HOURS = 72;
const MAX_EXPIRY_HOURS = 24 * 90;

const createSchema = {
  // The body is optional; `null` covers a request sent without one.
  body: {
    type: ['object', 'null'],
    additionalProperties: false,
    properties: { expiresInHours: { type: 'number', exclusiveMinimum: 0, maximum: MAX_EXPIRY_HOURS } },
  },
} as const;

const checkSchema = {
  querystring: {
    type: 'object',
    required: ['token'],
    properties: { token: { type: 'string', maxLength: 128 } },
  },
} as const;

interface InviteListRow {
  id: string;
  created_at: string;
  expires_at: string;
  used_at: string | null;
  used_by_name: string | null;
}

export function inviteRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const admin = requireAdmin(ctx);

  app.post<{ Body: { expiresInHours?: number } | null }>(
    '/api/invites',
    { schema: createSchema, onRequest: admin },
    async (request) => {
      const hours = request.body?.expiresInHours ?? DEFAULT_EXPIRY_HOURS;
      const token = randomToken(24);
      const expiresAt = new Date(Date.now() + hours * 3600_000).toISOString();
      db.prepare('INSERT INTO invites (id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?)').run(
        randomUUID(),
        sha256Hex(token),
        currentUser(request).id,
        nowIso(),
        expiresAt,
      );
      return { token, expiresAt };
    },
  );

  app.get('/api/invites', { onRequest: admin }, async () => {
    const rows = db
      .prepare(
        `SELECT i.id, i.created_at, i.expires_at, i.used_at, u.username AS used_by_name
         FROM invites i LEFT JOIN users u ON u.id = i.used_by
         ORDER BY i.created_at DESC`,
      )
      .all() as unknown as InviteListRow[];
    return {
      invites: rows.map((r) => ({
        id: r.id,
        createdAt: r.created_at,
        expiresAt: r.expires_at,
        ...(r.used_by_name ? { usedBy: r.used_by_name } : {}),
        ...(r.used_at ? { usedAt: r.used_at } : {}),
      })),
    };
  });

  // Public: lets the join page tell the user early whether their link still works.
  app.get<{ Querystring: { token: string } }>('/api/invites/check', { schema: checkSchema }, async (request) => {
    const row = db
      .prepare('SELECT 1 FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .get(sha256Hex(request.query.token), nowIso());
    return { valid: row !== undefined };
  });

  app.delete<{ Params: { id: string } }>(
    '/api/invites/:id',
    { schema: { params: idParams }, onRequest: admin },
    async (request) => {
      const result = db.prepare('DELETE FROM invites WHERE id = ?').run(request.params.id);
      if (result.changes === 0) throw notFound();
      return { ok: true };
    },
  );
}
