import type { FastifyInstance } from 'fastify';
import { type AppContext, currentUser, requireUser } from '../context.js';
import { nowIso, type UserSettingsRow } from '../db.js';
import { ApiError } from '../errors.js';
import { encSettings } from '../schemas.js';

interface PutBody {
  encSettings: string;
  baseUpdatedAt: string | null;
}

const putSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['encSettings', 'baseUpdatedAt'],
    properties: { encSettings, baseUpdatedAt: { type: ['string', 'null'], maxLength: 64 } },
  },
} as const;

export function settingsRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;
  const auth = { onRequest: requireUser(ctx) };
  const read = (userId: string) =>
    db.prepare('SELECT enc_settings, updated_at FROM user_settings WHERE user_id = ?').get(userId) as
      | Pick<UserSettingsRow, 'enc_settings' | 'updated_at'>
      | undefined;

  app.get('/api/me/settings', auth, async (request) => {
    const row = read(currentUser(request).id);
    return { encSettings: row?.enc_settings ?? null, updatedAt: row?.updated_at ?? null };
  });

  app.put<{ Body: PutBody }>('/api/me/settings', { ...auth, schema: putSchema }, async (request) => {
    const userId = currentUser(request).id;
    const row = read(userId);
    if ((row?.updated_at ?? null) !== request.body.baseUpdatedAt) {
      throw new ApiError(409, 'conflict', 'Settings changed on another device', {
        encSettings: row?.enc_settings ?? null,
        updatedAt: row?.updated_at ?? null,
      });
    }
    // A save in the same millisecond as the last one must still move updated_at, or a stale base would match.
    let updatedAt = nowIso();
    if (row && updatedAt <= row.updated_at) updatedAt = new Date(Date.parse(row.updated_at) + 1).toISOString();
    db.prepare(
      `INSERT INTO user_settings (user_id, enc_settings, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET enc_settings = excluded.enc_settings, updated_at = excluded.updated_at`,
    ).run(userId, request.body.encSettings, updatedAt);
    return { updatedAt };
  });
}
