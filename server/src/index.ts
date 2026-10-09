import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { redactUrl } from './logging.js';

const config = loadConfig();

const app = await buildApp({
  dataDir: config.dataDir,
  webDist: config.webDist,
  cookieSecure: config.cookieSecure,
  trustProxy: config.trustProxy,
  llmOrigins: config.llmOrigins,
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Log paths without query strings or invite tokens: those can carry usernames and secrets.
    serializers: {
      req: (req) => ({ method: req.method, url: redactUrl(req.url), remoteAddress: req.ip }),
    },
  },
});

app.log.info({ trustProxy: config.trustProxy }, 'proxy trust');
if (typeof config.trustProxy === 'number') {
  app.log.warn(
    'a hop count is only safe when the container is reachable solely through the proxy; otherwise use proxy IPs/CIDRs',
  );
}

if (!config.cookieSecure) {
  app.log.warn('COOKIE_SECURE is false; set COOKIE_SECURE=true when serving over HTTPS');
}

if (config.llmOrigins.length) app.log.info({ llmOrigins: config.llmOrigins }, 'Ask may call these origins from the browser');

let closing = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    if (closing) return;
    closing = true;
    app.log.info(`${signal} received, shutting down`);
    app.close().then(
      () => process.exit(0),
      (err) => {
        app.log.error(err);
        process.exit(1);
      },
    );
  });
}

try {
  await app.listen({ port: config.port, host: config.host });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
