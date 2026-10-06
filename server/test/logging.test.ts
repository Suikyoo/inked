import { describe, expect, it } from 'vitest';
import { redactUrl } from '../src/logging.js';

describe('redactUrl', () => {
  it('drops queries and invite tokens', () => {
    expect(redactUrl('/api/auth/params?username=bob')).toBe('/api/auth/params');
    expect(redactUrl('/join/abcDEF123_-')).toBe('/join/[redacted]');
    expect(redactUrl('/join/abc?x=1')).toBe('/join/[redacted]');
    expect(redactUrl('/v/123')).toBe('/v/123');
  });
});
