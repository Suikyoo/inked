/**
 * Path for logs: no query string, repeated slashes collapsed, and invite tokens (which live in
 * /join/<token>) removed. Anything under /join, in any case, is reduced to /join/[redacted].
 * The match also runs on a percent-decoded copy, because the SPA router decodes the path, so
 * /%6Aoin/<token> is a working invite link.
 */
export function redactUrl(url: string): string {
  const path = url.split('?')[0].replace(/\/{2,}/g, '/');
  let decoded = path;
  try {
    decoded = decodeURIComponent(url.split('?')[0]).replace(/\/{2,}/g, '/');
  } catch {
    // Malformed escape: match the raw path.
  }
  return /^\/join(\/|$)/i.test(path) || /^\/join(\/|$)/i.test(decoded) ? '/join/[redacted]' : path;
}
