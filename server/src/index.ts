import { buildApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();

const app = await buildApp({
  dataDir: config.dataDir,
  webDist: config.webDist,
  cookieSecure: config.cookieSecure,
  trustProxy: config.trustProxy,
  logger: {
    level: process.env.LOG_LEVEL || 'info',
    // Log paths without query strings: those can carry invite tokens and usernames.
    serializers: {
      req: (req) => ({ method: req.method, url: req.url.split('?')[0], remoteAddress: req.ip }),
    },
  },
});

app.log.info(
  { trustProxy: config.trustProxy },
  'proxy trust (a hop count is only safe when the container is reachable solely through the proxy; otherwise use proxy IPs/CIDRs)',
);

if (!config.cookieSecure) {
  app.log.warn('COOKIE_SECURE is false; set COOKIE_SECURE=true when serving over HTTPS');
}

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
