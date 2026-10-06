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
});
