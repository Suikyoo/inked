/** Path for logs: no query string, and invite tokens (which live in /join/<token>) removed. */
export function redactUrl(url: string): string {
  const path = url.split('?')[0];
  return path.replace(/^\/join\/[^/]+/,'/join/[redacted]');
}
