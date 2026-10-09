import { describe, expect, it } from 'vitest';
import { toFastifyTrustProxy } from '../src/app.js';
import { loadConfig, parseLlmOrigins, parseTrustProxy } from '../src/config.js';

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
  it('treats 0 and off as false, ignoring case and whitespace', () => {
    expect(parseTrustProxy('0')).toBe(false);
    expect(parseTrustProxy('off')).toBe(false);
    expect(parseTrustProxy('  TRUE ')).toBe(1);
    expect(parseTrustProxy(' FALSE ')).toBe(false);
  });
  it('accepts IPv6 addresses and CIDRs', () => {
    expect(parseTrustProxy('fd00::/8')).toBe('fd00::/8');
    expect(parseTrustProxy('::1')).toBe('::1');
  });
  it('rejects malformed addresses and prefixes', () => {
    for (const bad of ['...', ':::', '1.2.3.4/999', '1.2.3.4/33', 'fd00::/129', '1.2.3.4/', '1.2.3.4/8/8']) {
      expect(() => parseTrustProxy(bad), bad).toThrow(/TRUST_PROXY/);
    }
  });
  it('rejects garbage', () => {
    expect(() => parseTrustProxy('yes please')).toThrow(/TRUST_PROXY/);
  });
});

describe('toFastifyTrustProxy', () => {
  it('turns a hop count into a function that trusts the first N hops', () => {
    const f = toFastifyTrustProxy(2) as (addr: string, hop: number) => boolean;
    expect(typeof f).toBe('function');
    expect(f('x', 0)).toBe(true);
    expect(f('x', 1)).toBe(true);
    expect(f('x', 2)).toBe(false);
  });
  it('passes strings and false through', () => {
    expect(toFastifyTrustProxy(false)).toBe(false);
    expect(toFastifyTrustProxy('127.0.0.0/8')).toBe('127.0.0.0/8');
  });
});

describe('INKED_LLM_ORIGINS', () => {
  it('is empty when unset', () => {
    expect(parseLlmOrigins(undefined)).toEqual([]);
    expect(parseLlmOrigins(' ')).toEqual([]);
  });
  it('accepts https origins and localhost http, normalised', () => {
    expect(parseLlmOrigins('https://api.openai.com, http://localhost:11434,http://127.0.0.1')).toEqual([
      'https://api.openai.com',
      'http://localhost:11434',
      'http://127.0.0.1',
    ]);
  });
  it('rejects paths, other schemes and non-local http', () => {
    expect(() => parseLlmOrigins('https://api.openai.com/v1')).toThrow(/INKED_LLM_ORIGINS/);
    expect(() => parseLlmOrigins('http://api.openai.com')).toThrow(/INKED_LLM_ORIGINS/);
    expect(() => parseLlmOrigins('ftp://x.example')).toThrow(/INKED_LLM_ORIGINS/);
    expect(() => parseLlmOrigins("https://a.example 'unsafe-inline'")).toThrow(/INKED_LLM_ORIGINS/);
  });
  it('is part of the config', () => {
    expect(loadConfig({ INKED_LLM_ORIGINS: 'https://api.openai.com' } as NodeJS.ProcessEnv).llmOrigins).toEqual(['https://api.openai.com']);
  });
});
