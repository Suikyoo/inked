import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { deviceTag, randomToken, sha256Hex } from './crypto.js';
import type { Db, UserRow } from './db.js';
import { ApiError, unauthorized } from './errors.js';
import type { FailureLimiter } from './limiter.js';

/** Shared state handed to every route module. */
export interface AppContext {
  db: Db;
  serverSecret: Buffer;
  cookieSecure: boolean;
  limiter: FailureLimiter;
  /** Per-username cap, independent of client IP. */
  accountLimiter: FailureLimiter;
  /** One-time first-run setup token; null once setup is done (or was not needed). */
  setupToken: string | null;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: UserRow | null;
    sessionHash: string | null;
  }
}

export const SESSION_COOKIE = 'inked_session';
/** Marks a browser that has signed in to an account before; exempts it from the per-account login cap. */
export const DEVICE_COOKIE = 'inked_device';
const DEVICE_TTL_S = 180 * 24 * 60 * 60;
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// Sliding expiry is refreshed at most this often, to avoid a DB write per request.
const SESSION_REFRESH_MS = 60 * 60 * 1000;

const iso = (ms: number) => new Date(ms).toISOString();

export const publicUser = (u: UserRow) => ({ id: u.id, username: u.username, isAdmin: u.is_admin === 1 });

function setSessionCookie(ctx: AppContext, reply: FastifyReply, token: string): void {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
    secure: ctx.cookieSecure,
    maxAge: SESSION_TTL_MS / 1000,
  });
}

export function clearSessionCookie(ctx: AppContext, reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, sameSite: 'strict', path: '/', secure: ctx.cookieSecure });
}

/**
 * Issued on every successful password login, recover/finish, setup and register: base64url(userId) + "." +
 * base64url(HMAC-SHA256(serverSecret, "device:" + userId + ":" + auth_salt)). Logout leaves it in place on purpose.
 */
export function setDeviceCookie(ctx: AppContext, reply: FastifyReply, user: { id: string; auth_salt: string }): void {
  const value = `${Buffer.from(user.id).toString('base64url')}.${deviceTag(ctx.serverSecret, user.id, user.auth_salt).toString('base64url')}`;
  reply.setCookie(DEVICE_COOKIE, value, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/api/auth',
    secure: ctx.cookieSecure,
    maxAge: DEVICE_TTL_S,
  });
}

/**
 * True only when the request carries a device cookie this server minted for `user`. The tag is
 * checked (in constant time) whether or not the user exists, so the cost never depends on that.
 */
export function isKnownDevice(ctx: AppContext, request: FastifyRequest, user: UserRow | undefined): boolean {
  const value = request.cookies[DEVICE_COOKIE];
  const dot = value ? value.indexOf('.') : -1;
  if (!value || dot < 0) return false;
  const claimedId = Buffer.from(value.slice(0, dot), 'base64url').toString('utf8');
  const tag = Buffer.from(value.slice(dot + 1), 'base64url');
  const expected = deviceTag(ctx.serverSecret, claimedId, user && user.id === claimedId ? user.auth_salt : '');
  const valid = tag.length === expected.length && timingSafeEqual(tag, expected);
  return valid && user !== undefined && claimedId === user.id;
}

export function startSession(ctx: AppContext, reply: FastifyReply, userId: string): void {
  const token = randomToken(32);
  const now = Date.now();
  ctx.db
    .prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256Hex(token), userId, iso(now), iso(now + SESSION_TTL_MS));
  setSessionCookie(ctx, reply, token);
}

export function endSession(ctx: AppContext, request: FastifyRequest, reply: FastifyReply): void {
  const token = request.cookies[SESSION_COOKIE];
  if (token) ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256Hex(token));
  clearSessionCookie(ctx, reply);
}

/** Resolves the session cookie to its user and slides the expiry; null when absent or expired. */
function loadSession(ctx: AppContext, request: FastifyRequest, reply: FastifyReply) {
  const token = request.cookies[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = sha256Hex(token);
  const row = ctx.db
    .prepare('SELECT s.expires_at AS session_expires_at, u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?')
    .get(tokenHash) as (UserRow & { session_expires_at: string }) | undefined;
  if (!row) return null;

  const now = Date.now();
  const expiresAt = Date.parse(row.session_expires_at);
  if (expiresAt <= now) {
    ctx.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash);
    return null;
  }
  if (expiresAt - now < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    ctx.db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(iso(now + SESSION_TTL_MS), tokenHash);
    setSessionCookie(ctx, reply, token);
  }
  const { session_expires_at: _ignored, ...user } = row;
  return { user: user as UserRow, tokenHash };
}

export function deleteExpiredSessions(db: Db): void {
  db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(iso(Date.now()));
}

/** The account a client expects its session to belong to; optional (older clients, auth routes). */
export const USER_HEADER = 'x-inked-user';

/**
 * onRequest guard: requires a valid session and sets request.user.
 *
 * All tabs of a browser share the session cookie, so a tab can hold one account's keys and queued
 * ciphertext while another tab has signed in as someone else. When the request names its account in
 * X-Inked-User and that is not the session's, it is refused with 409 `user_mismatch` before any lookup,
 * rather than answered (wrongly) as the other account. `ignoreUserHeader` is for the auth routes.
 */
export function requireUser(ctx: AppContext, opts: { ignoreUserHeader?: boolean } = {}) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const session = loadSession(ctx, request, reply);
    if (!session) {
      if (request.cookies[SESSION_COOKIE]) clearSessionCookie(ctx, reply);
      throw unauthorized();
    }
    const expected = request.headers[USER_HEADER];
    if (!opts.ignoreUserHeader && expected !== undefined && expected !== session.user.id) {
      throw new ApiError(409, 'user_mismatch');
    }
    request.user = session.user;
    request.sessionHash = session.tokenHash;
  };
}

/** onRequest guard: requires a valid session (bound like requireUser) for an admin user. */
export function requireAdmin(ctx: AppContext) {
  const userCheck = requireUser(ctx);
  return async (request: FastifyRequest, reply: FastifyReply) => {
    await userCheck(request, reply);
    if (request.user?.is_admin !== 1) throw new ApiError(403, 'forbidden');
  };
}

/** The authenticated user; only valid in routes guarded by requireUser/requireAdmin. */
export function currentUser(request: FastifyRequest): UserRow {
  if (!request.user) throw unauthorized();
  return request.user;
}
