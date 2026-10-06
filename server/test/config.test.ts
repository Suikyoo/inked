import { describe, expect, it } from 'vitest';
import { parseTrustProxy } from '../src/config.js';

describe('parseTrustProxy', () => {
  it('defaults to false', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
  });
  it('accepts a hop count', () => {
    expect(parseTrustProxy('1')).toBe(1);
    expect(parseTrustProxy('2')).toBe(2);
  });
  it('maps "true" to exactly one hop instead of trusting every hop', () => {
    expect(parseTrustProxy('true')).toBe(1);
  });
  it('accepts IP / CIDR lists', () => {
    expect(parseTrustProxy('172.16.0.0/12, 10.0.0.5')).toBe('172.16.0.0/12,10.0.0.5');
  });
  it('rejects garbage', () => {
    expect(() => parseTrustProxy('yes please')).toThrow(/TRUST_PROXY/);
  });
});
