/**
 * Path for logs: no query string, repeated slashes collapsed, and invite tokens (which live in
 * /join/<token>) removed. Anything under /join, in any case, is reduced to /join/[redacted].
 */
export function redactUrl(url: string): string {
  const path = url.split('?')[0].replace(/\/{2,}/g, '/');
  return /^\/join(\/|$)/i.test(path) ? '/join/[redacted]' : path;
}
