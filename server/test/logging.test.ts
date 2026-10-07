import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/logging.js';

describe('redactUrl', () => {
  it('drops queries and invite tokens', () => {
    expect(redactUrl('/api/auth/params?username=bob')).toBe('/api/auth/params');
    expect(redactUrl('/join/abcDEF123_-')).toBe('/join/[redacted]');
    expect(redactUrl('/join/abc?x=1')).toBe('/join/[redacted]');
    expect(redactUrl('/v/123')).toBe('/v/123');
  });

  it('collapses slashes and ignores case so tokens cannot slip through (B5)', () => {
    expect(redactUrl('//join/abc')).toBe('/join/[redacted]');
    expect(redactUrl('/JOIN/abc')).toBe('/join/[redacted]');
    expect(redactUrl('/join/')).toBe('/join/[redacted]');
    expect(redactUrl('/join/abc/')).toBe('/join/[redacted]');
    expect(redactUrl('/join//abc/def?x=1')).toBe('/join/[redacted]');
    expect(redactUrl('/v//123')).toBe('/v/123');
  });

  it('redacts percent-encoded /join paths (D2a)', () => {
    for (const u of ['/%6Aoin/abc', '/%6a%6f%69%6e/abc', '/%6a%6F%69%6E/tok', '//JOIN/tok', '/%2Fjoin/abc', '/join%2Fabc']) {
      expect(redactUrl(u)).toBe('/join/[redacted]');
    }
    expect(redactUrl('/api/notes/x?y=1')).toBe('/api/notes/x');
  });

  it('leaves malformed escapes and harmless escapes alone (D2a)', () => {
    expect(redactUrl('/%E0%A4%A/x')).toBe('/%E0%A4%A/x');
    expect(redactUrl('/v/%41')).toBe('/v/%41');
  });
});
