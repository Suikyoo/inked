import { describe, expect, it } from 'vitest';
import { inkTier } from './recency';

const NOW = Date.parse('2026-10-07T12:00:00.000Z');
const H = 3_600_000;
const D = 24 * H;
const ago = (ms: number) => new Date(NOW - ms).toISOString();

describe('inkTier', () => {
  it('steps wet → fresh → drying → dry at 24 h, 7 d and 30 d (upper bounds exclusive)', () => {
    expect(inkTier(ago(D - 1), NOW)).toBe('wet');
    expect(inkTier(ago(D), NOW)).toBe('fresh');
    expect(inkTier(ago(7 * D - 1), NOW)).toBe('fresh');
    expect(inkTier(ago(7 * D), NOW)).toBe('drying');
    expect(inkTier(ago(30 * D - 1), NOW)).toBe('drying');
    expect(inkTier(ago(30 * D), NOW)).toBe('dry');
  });

  it('treats unparseable and future timestamps as wet', () => {
    expect(inkTier('not a date', NOW)).toBe('wet');
    expect(inkTier(ago(-H), NOW)).toBe('wet');
  });
});
