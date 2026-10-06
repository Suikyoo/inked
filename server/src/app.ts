import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyCookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import { randomBytes } from 'node:crypto';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyServerOptions } from 'fastify';
import { type AppContext, deleteExpiredSessions } from './context.js';
import { loadServerSecret } from './crypto.js';
import { type Db, openDb } from './db.js';
import { ApiError } from './errors.js';
import { FailureLimiter } from './limiter.js';
import { authRoutes, countUsers } from './routes/auth.js';
import { folderRoutes } from './routes/folders.js';
import { inviteRoutes } from './routes/invites.js';
import { noteRoutes } from './routes/notes.js';
import { vaultRoutes } from './routes/vaults.js';
import { BODY_LIMIT } from './schemas.js';

export interface AppOptions {
  dataDir: string;
  webDist: string;
  cookieSecure: boolean;
  trustProxy?: false | number | string;
  /** Fixed setup token (tests); by default one is generated and logged when no users exist. */
  setupToken?: string;
  logger?: FastifyServerOptions['logger'];
}

declare module 'fastify' {
  interface FastifyInstance {
    db: Db;
    /** The pending first-run setup token, null once setup is done (read-only; for tests). */
    readonly setupToken: string | null;
  }
}

const SECURITY_HEADERS: Record<string, string> = {
  'content-security-policy':
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; " +
    "img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; " +
    "frame-ancestors 'none'; form-action 'self'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
  'cross-origin-opener-policy': 'same-origin',
};

const SAFE_METHODS = new Set(['GET', 'HEAD']);
const isApiPath = (url: string) => /^\/api(\/|\?|$)/.test(url);

/** Error code for Fastify's own 4xx errors (body too large, bad JSON, ...). */
function clientErrorCode(err: FastifyError, status: number): string {
  if (status === 413) return 'too_large';
  if (status === 415) return 'unsupported_media_type';
  if (err.code?.startsWith('FST_ERR_CTP_')) return 'invalid_body';
  if (status === 404) return 'not_found';
  return 'bad_request';
}

type FastifyTrustProxy = boolean | string | ((addr: string, hop: number) => boolean);

/** Fastify 5 turns a numeric trustProxy into "trust nobody", so express a hop count as a trust function (hop 0 is the immediate peer). */
export function toFastifyTrustProxy(value: false | number | string): FastifyTrustProxy {
  return typeof value === 'number' ? (_addr, hop) => hop < value : value;
}

export async function buildApp(opts: AppOptions): Promise<FastifyInstance> {
  const serverSecret = loadServerSecret(opts.dataDir);
  const db = openDb(path.join(opts.dataDir, 'inked.db'));

  const app = Fastify({
    bodyLimit: BODY_LIMIT,
    trustProxy: toFastifyTrustProxy(opts.trustProxy ?? false),
    ajv: { customOptions: { coerceTypes: false } },
    logger: opts.logger ?? false,
  });
  app.decorate('db', db);
  app.decorateRequest('user', null);
  app.decorateRequest('sessionHash', null);

  const ctx: AppContext = {
    db,
    serverSecret,
    cookieSecure: opts.cookieSecure,
    limiter: new FailureLimiter(),
    accountLimiter: new FailureLimiter(30, 15 * 60_000, 15 * 60_000),
    setupToken: opts.setupToken ?? (countUsers(db) === 0 ? randomBytes(16).toString('base64url') : null),
  };
  if (ctx.setupToken && !opts.setupToken) {
    app.log.warn(`Inked first-run setup token: ${ctx.setupToken}`);
    // Unconditional, so the token is visible even with LOG_LEVEL=silent.
    process.stderr.write(`Inked first-run setup token: ${ctx.setupToken}\n`);
  }
  app.decorate('setupToken', { getter: () => ctx.setupToken });

  // Housekeeping: drop expired sessions now and hourly.
  deleteExpiredSessions(db);
  const sweeper = setInterval(() => {
    deleteExpiredSessions(db);
    ctx.limiter.prune();
    ctx.accountLimiter.prune();
  }, 60 * 60 * 1000);
  sweeper.unref();
  app.addHook('onClose', async () => {
    clearInterval(sweeper);
    db.close();
  });

  await app.register(fastifyCookie);

  // Accept an empty body with a JSON content type (e.g. a bodiless POST /logout).
  const defaultJsonParser = app.getDefaultJsonParser('error', 'error');
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (request, body, done) => {
    if (body === '') return done(null, undefined);
    defaultJsonParser(request, body as string, done);
  });

  // CSRF: every state-changing request must carry the custom header (SameSite=Strict does the rest).
  app.addHook('onRequest', async (request) => {
    if (!SAFE_METHODS.has(request.method) && request.headers['x-inked'] !== '1') {
      throw new ApiError(403, 'csrf', 'Missing X-Inked header');
    }
  });

  app.addHook('onSend', async (request, reply, payload) => {
    reply.headers(SECURITY_HEADERS);
    if (isApiPath(request.url)) reply.header('cache-control', 'no-store');
    return payload;
  });

  app.setErrorHandler<FastifyError | ApiError>((err, request, reply) => {
    if (err instanceof ApiError) {
      if (err.headers) reply.headers(err.headers);
      return reply
        .code(err.statusCode)
        .send({ error: err.code, ...(err.message ? { message: err.message } : {}), ...err.extra });
    }
    if (err.validation?.some((v) => v.keyword === 'maxLength' && /encBody/.test(v.instancePath))) {
      return reply.code(413).send({ error: 'too_large', message: 'Note is too large' });
    }
    if (err.validation) {
      return reply.code(400).send({ error: 'invalid_request', message: err.message });
    }
    const status = err.statusCode ?? 500;
    if (status >= 400 && status < 500) {
      return reply.code(status).send({ error: clientErrorCode(err, status), message: err.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: 'internal' });
  });

  authRoutes(app, ctx);
  inviteRoutes(app, ctx);
  vaultRoutes(app, ctx);
  folderRoutes(app, ctx);
  noteRoutes(app, ctx);

  // The SPA is optional: without a built web/dist the server is API-only.
  const hasWeb = existsSync(path.join(opts.webDist, 'index.html'));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: opts.webDist,
      setHeaders(reply, filePath) {
        // Vite emits content-hashed files under assets/; everything else must revalidate.
        const hashed = filePath.includes(`${path.sep}assets${path.sep}`);
        reply.header('cache-control', hashed ? 'public, max-age=31536000, immutable' : 'no-cache');
      },
    });
  }

  app.setNotFoundHandler((request, reply) => {
    if (hasWeb && SAFE_METHODS.has(request.method) && !isApiPath(request.url)) {
      return reply.sendFile('index.html');
    }
    return reply.code(404).send({ error: 'not_found' });
  });

  return app;
}
