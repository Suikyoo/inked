import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  type AppContext,
  currentUser,
  endSession,
  isKnownDevice,
  publicUser,
  requireUser,
  setDeviceCookie,
  startSession,
} from '../context.js';
import { burnScrypt, fakeKdfSalt, hashSecret, safeEqualStrings, sha256Hex, verifySecret } from '../crypto.js';
import { type Db, nowIso, transaction, type UserRow } from '../db.js';
import { ApiError } from '../errors.js';
import {
  DEFAULT_KDF_PARAMS,
  type KdfParams,
  kdfParams,
  kdfSalt,
  key32,
  normalizeKdfParams,
  username,
  uuid,
  wrappedKey,
} from '../schemas.js';

interface RegisterBody {
  inviteToken?: string;
  userId: string;
  username: string;
  kdfSalt: string;
  kdfParams: KdfParams;
  authKey: string;
  wrappedUserKey: string;
  recoveryAuth: string;
  wrappedUserKeyRecovery: string;
}

interface NewCredentials {
  kdfSalt: string;
  kdfParams: KdfParams;
  authKey: string;
  wrappedUserKey: string;
}

const registerFields = {
  userId: uuid,
  username,
  kdfSalt,
  kdfParams,
  authKey: key32,
  wrappedUserKey: wrappedKey,
  recoveryAuth: key32,
  wrappedUserKeyRecovery: wrappedKey,
} as const;
const registerRequired = Object.keys(registerFields);

const setupSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: [...registerRequired, 'setupToken'],
    properties: { ...registerFields, setupToken: { type: 'string', minLength: 8, maxLength: 128 } },
  },
} as const;

const registerSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: [...registerRequired, 'inviteToken'],
    properties: { ...registerFields, inviteToken: { type: 'string', minLength: 1, maxLength: 128 } },
  },
} as const;

const credentialFields = { kdfSalt, kdfParams, authKey: key32, wrappedUserKey: wrappedKey } as const;

const loginSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'authKey'],
    properties: { username, authKey: key32 },
  },
} as const;

const passwordSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['currentAuthKey', 'kdfSalt', 'kdfParams', 'authKey', 'wrappedUserKey'],
    properties: { currentAuthKey: key32, ...credentialFields },
  },
} as const;

const recoveryKeySchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['currentAuthKey', 'recoveryAuth', 'wrappedUserKeyRecovery'],
    properties: { currentAuthKey: key32, recoveryAuth: key32, wrappedUserKeyRecovery: wrappedKey },
  },
} as const;

const recoverStartSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'recoveryAuth'],
    properties: { username, recoveryAuth: key32 },
  },
} as const;

const recoverFinishSchema = {
  body: {
    type: 'object',
    additionalProperties: false,
    required: ['username', 'recoveryAuth', 'kdfSalt', 'kdfParams', 'authKey', 'wrappedUserKey'],
    properties: { username, recoveryAuth: key32, ...credentialFields },
  },
} as const;

const paramsSchema = {
  querystring: {
    type: 'object',
    required: ['username'],
    properties: { username },
  },
} as const;

export const countUsers = (db: Db) => (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;

const findUser = (db: Db, name: string) =>
  db.prepare('SELECT * FROM users WHERE username = ?').get(name) as UserRow | undefined;

const lockedError = (retryAfter: number) =>
  new ApiError(429, 'locked', 'Too many failed attempts', { retryAfter }, { 'retry-after': String(retryAfter) });

const invalidCredentials = () => new ApiError(401, 'invalid_credentials');

/**
 * Verifies a client-derived secret for `name` with lockout on repeated failure.
 * Unknown users cost the same scrypt work and fail identically.
 * A known device (valid `inked_device` cookie for this user) skips the per-account cap entirely,
 * so an attacker who trips it only blocks new devices; the per-(IP, user) limit always applies.
 */
async function checkSecret(
  ctx: AppContext,
  request: FastifyRequest,
  scope: string,
  name: string,
  secret: string,
  stored: (u: UserRow) => { salt: string; hash: string },
): Promise<UserRow> {
  const key = `${scope}|${request.ip}|${name}`;
  const accountKey = `${scope}|${name}`;
  const user = findUser(ctx.db, name);
  // Without a valid cookie for this very user the account limiter is consulted as before.
  const useAccountLimit = !isKnownDevice(ctx, request, user);
  // Check both before recording either, so a request one limiter rejects never spends the other's budget.
  const locked = Math.max(ctx.limiter.retryAfter(key), useAccountLimit ? ctx.accountLimiter.retryAfter(accountKey) : 0);
  if (locked > 0) throw lockedError(locked);
  ctx.limiter.attempt(key);
  if (useAccountLimit) ctx.accountLimiter.attempt(accountKey);

  const ok = user ? await verifySecret(secret, stored(user)) : (await burnScrypt(secret), false);
  if (!user || !ok) throw invalidCredentials();
  ctx.limiter.reset(key);
  if (useAccountLimit) ctx.accountLimiter.reset(accountKey);
  return user;
}

const authOf = (u: UserRow) => ({ salt: u.auth_salt, hash: u.auth_hash });
const recoveryOf = (u: UserRow) => ({ salt: u.recovery_salt, hash: u.recovery_hash });

/** Replaces the password-derived credentials (kdf salt/params, auth hash, wrapped user key). */
async function replaceCredentials(db: Db, userId: string, c: NewCredentials): Promise<void> {
  const auth = await hashSecret(c.authKey);
  db.prepare(
    `UPDATE users SET kdf_salt = ?, kdf_params = ?, auth_salt = ?, auth_hash = ?, wrapped_user_key = ? WHERE id = ?`,
  ).run(c.kdfSalt, JSON.stringify(normalizeKdfParams(c.kdfParams)), auth.salt, auth.hash, c.wrappedUserKey, userId);
}

async function hashRegistration(b: RegisterBody) {
  const [auth, recovery] = await Promise.all([hashSecret(b.authKey), hashSecret(b.recoveryAuth)]);
  return { auth, recovery };
}

/** Inserts a user; must be called inside a transaction. Throws 409 on username/id clash. */
function insertUser(
  db: Db,
  b: RegisterBody,
  hashes: Awaited<ReturnType<typeof hashRegistration>>,
  isAdmin: boolean,
): UserRow {
  const name = b.username.toLowerCase();
  if (findUser(db, name)) throw new ApiError(409, 'username_taken');
  if (db.prepare('SELECT 1 FROM users WHERE id = ?').get(b.userId)) throw new ApiError(409, 'id_taken');
  db.prepare(
    `INSERT INTO users (id, username, is_admin, kdf_salt, kdf_params, auth_salt, auth_hash, wrapped_user_key,
                        recovery_salt, recovery_hash, wrapped_user_key_recovery, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    b.userId,
    name,
    isAdmin ? 1 : 0,
    b.kdfSalt,
    JSON.stringify(normalizeKdfParams(b.kdfParams)),
    hashes.auth.salt,
    hashes.auth.hash,
    b.wrappedUserKey,
    hashes.recovery.salt,
    hashes.recovery.hash,
    b.wrappedUserKeyRecovery,
    nowIso(),
  );
  return findUser(db, name)!;
}

export function authRoutes(app: FastifyInstance, ctx: AppContext): void {
  const { db } = ctx;

  app.get('/api/status', async () => ({ needsSetup: countUsers(db) === 0 }));

  app.post<{ Body: RegisterBody & { setupToken: string } }>('/api/setup', { schema: setupSchema }, async (request, reply) => {
    if (countUsers(db) > 0) throw new ApiError(409, 'already_setup');
    if (!ctx.setupToken || !safeEqualStrings(request.body.setupToken, ctx.setupToken)) {
      throw new ApiError(403, 'invalid_setup_token');
    }
    const hashes = await hashRegistration(request.body);
    const user = transaction(db, () => {
      // Re-check inside the transaction: another setup may have finished while we hashed.
      if (countUsers(db) > 0) throw new ApiError(409, 'already_setup');
      return insertUser(db, request.body, hashes, true);
    });
    ctx.setupToken = null;
    startSession(ctx, reply, user.id);
    setDeviceCookie(ctx, reply, user);
    return { user: publicUser(user) };
  });

  app.get<{ Querystring: { username: string } }>('/api/auth/params', { schema: paramsSchema }, async (request) => {
    const name = request.query.username.toLowerCase();
    const user = findUser(db, name);
    if (user) return { kdfSalt: user.kdf_salt, kdfParams: JSON.parse(user.kdf_params) as KdfParams };
    return { kdfSalt: fakeKdfSalt(ctx.serverSecret, name), kdfParams: DEFAULT_KDF_PARAMS };
  });

  app.post<{ Body: { username: string; authKey: string } }>(
    '/api/auth/login',
    { schema: loginSchema },
    async (request, reply) => {
      const name = request.body.username.toLowerCase();
      const user = await checkSecret(ctx, request, 'login', name, request.body.authKey, authOf);
      startSession(ctx, reply, user.id);
      setDeviceCookie(ctx, reply, user);
      return { user: publicUser(user), wrappedUserKey: user.wrapped_user_key };
    },
  );

  app.post('/api/auth/logout', async (request, reply) => {
    endSession(ctx, request, reply);
    return { ok: true };
  });

  app.get('/api/me', { onRequest: requireUser(ctx, { ignoreUserHeader: true }) }, async (request) => {
    const user = currentUser(request);
    return { user: publicUser(user), wrappedUserKey: user.wrapped_user_key };
  });

  app.post<{ Body: RegisterBody }>('/api/auth/register', { schema: registerSchema }, async (request, reply) => {
    const tokenHash = sha256Hex(request.body.inviteToken!);
    const live = () =>
      db
        .prepare('SELECT id FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
        .get(tokenHash, nowIso()) as { id: string } | undefined;
    // Cheap check first: a bad invite must not cost two scrypt hashes.
    if (!live()) throw new ApiError(403, 'invalid_invite');
    const hashes = await hashRegistration(request.body);
    const user = transaction(db, () => {
      const invite = live(); // re-check: it may have been used while we hashed
      if (!invite) throw new ApiError(403, 'invalid_invite');
      const created = insertUser(db, request.body, hashes, false);
      db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?').run(created.id, nowIso(), invite.id);
      return created;
    });
    startSession(ctx, reply, user.id);
    setDeviceCookie(ctx, reply, user);
    return { user: publicUser(user) };
  });

  app.post<{ Body: NewCredentials & { currentAuthKey: string } }>(
    '/api/auth/password',
    { schema: passwordSchema, onRequest: requireUser(ctx, { ignoreUserHeader: true }) },
    async (request, reply) => {
      const user = currentUser(request);
      const key = `password|${request.ip}|${user.id}`;
      const wait = ctx.limiter.attempt(key);
      if (wait > 0) throw lockedError(wait);
      if (!(await verifySecret(request.body.currentAuthKey, authOf(user)))) {
        // 403 rather than 401: the session is fine, the proof is not.
        throw new ApiError(403, 'invalid_credentials');
      }
      ctx.limiter.reset(key);
      await replaceCredentials(db, user.id, request.body);
      // Sign out every other session.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(user.id, request.sessionHash);
      // Re-read: replaceCredentials rotated auth_salt, so earlier device cookies stopped counting; keep this device known.
      setDeviceCookie(ctx, reply, findUser(db, user.username)!);
      return { ok: true };
    },
  );

  app.post<{ Body: { currentAuthKey: string; recoveryAuth: string; wrappedUserKeyRecovery: string } }>(
    '/api/auth/recovery-key',
    { schema: recoveryKeySchema, onRequest: requireUser(ctx, { ignoreUserHeader: true }) },
    async (request) => {
      const user = currentUser(request);
      const key = `recoverykey|${request.ip}|${user.id}`;
      const wait = ctx.limiter.attempt(key);
      if (wait > 0) throw lockedError(wait);
      if (!(await verifySecret(request.body.currentAuthKey, authOf(user)))) throw new ApiError(403, 'invalid_credentials');
      ctx.limiter.reset(key);
      const rec = await hashSecret(request.body.recoveryAuth);
      db.prepare('UPDATE users SET recovery_salt = ?, recovery_hash = ?, wrapped_user_key_recovery = ? WHERE id = ?').run(
        rec.salt,
        rec.hash,
        request.body.wrappedUserKeyRecovery,
        user.id,
      );
      return { ok: true };
    },
  );

  app.post<{ Body: { username: string; recoveryAuth: string } }>(
    '/api/auth/recover/start',
    { schema: recoverStartSchema },
    async (request) => {
      const name = request.body.username.toLowerCase();
      const user = await checkSecret(ctx, request, 'recover', name, request.body.recoveryAuth, recoveryOf);
      return { userId: user.id, wrappedUserKeyRecovery: user.wrapped_user_key_recovery };
    },
  );

  app.post<{ Body: NewCredentials & { username: string; recoveryAuth: string } }>(
    '/api/auth/recover/finish',
    { schema: recoverFinishSchema },
    async (request, reply) => {
      const name = request.body.username.toLowerCase();
      const user = await checkSecret(ctx, request, 'recover', name, request.body.recoveryAuth, recoveryOf);
      await replaceCredentials(db, user.id, request.body);
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
      // Re-read: replaceCredentials rotated auth_salt, and the device cookie is bound to the new one.
      const updated = findUser(db, name)!;
      startSession(ctx, reply, updated.id);
      setDeviceCookie(ctx, reply, updated);
      return { user: publicUser(user), wrappedUserKey: request.body.wrappedUserKey };
    },
  );
}
