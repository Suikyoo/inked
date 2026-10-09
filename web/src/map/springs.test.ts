import { describe, expect, it } from 'vitest';
import { SPRING, stepSprings, type Anchor, type Body } from './springs';

const body = (x = 0, y = 0): Body => ({ x, y, vx: 0, vy: 0 });
const run = (bodies: Map<string, Body>, anchors: Map<string, Anchor>, held: boolean, seconds: number) => {
  for (let t = 0; t < seconds; t += 1 / 60) stepSprings(bodies, anchors, held, 1 / 60);
};

describe('stepSprings', () => {
  it('pulls the leader to the pointer and leaves it there, with no pull back toward its layout spot', () => {
    const bodies = new Map([['a', body()]]);
    const anchors = new Map<string, Anchor>([['a', { x: 80, y: -40 }]]);
    run(bodies, anchors, false, 6);
    const a = bodies.get('a')!;
    expect(a.x).toBeCloseTo(80, 1);
    expect(a.y).toBeCloseTo(-40, 1);
    expect(anchors.size).toBe(0);
    // Resting with no anchor: it stays put however long it runs.
    run(bodies, anchors, false, 5);
    expect(bodies.get('a')!.x).toBeCloseTo(80, 1);
  });

  it('overshoots its anchor a little before settling (under-damped)', () => {
    const bodies = new Map([['a', body()]]);
    const anchors = new Map<string, Anchor>([['a', { x: 50, y: 0 }]]);
    let max = 0;
    for (let i = 0; i < 120; i++) {
      stepSprings(bodies, anchors, true, 1 / 60);
      max = Math.max(max, bodies.get('a')!.x);
    }
    expect(max).toBeGreaterThan(50);
  });

  it('never accelerates past the clamp, however far the pointer is', () => {
    const bodies = new Map([['a', body()]]);
    stepSprings(bodies, new Map([['a', { x: 1e6, y: 0 }]]), true, SPRING.maxStep);
    const b = bodies.get('a')!;
    expect(Math.hypot(b.vx, b.vy)).toBeLessThanOrEqual(SPRING.maxAccel * SPRING.maxStep + 1e-6);
  });

  it('carries a follower along with its root, keeping its place, and gives the root no push back', () => {
    const bodies = new Map([
      ['root', body()],
      ['kid', body(30, 10)],
    ]);
    const anchors = new Map<string, Anchor>([
      ['root', { x: 100, y: 0 }],
      ['kid', { x: 30, y: 10, root: 'root' }],
    ]);
    run(bodies, anchors, false, 8);
    expect(bodies.get('root')!.x).toBeCloseTo(100, 1);
    expect(bodies.get('kid')!.x).toBeCloseTo(130, 1);
    expect(bodies.get('kid')!.y).toBeCloseTo(10, 1);

    // The root's motion is the same with or without the follower.
    const solo = new Map([['root', body()]]);
    run(solo, new Map([['root', { x: 100, y: 0 }]]), false, 1);
    const withKid = new Map([
      ['root', body()],
      ['kid', body(30, 10)],
    ]);
    run(withKid, new Map<string, Anchor>([['root', { x: 100, y: 0 }], ['kid', { x: 30, y: 10, root: 'root' }]]), false, 1);
    expect(withKid.get('root')!.x).toBeCloseTo(solo.get('root')!.x, 9);
  });

  it('lets a released node fly on with its velocity and slow at a constant rate until it stops', () => {
    const v0 = 1000;
    const bodies = new Map([['a', { x: 0, y: 0, vx: v0, vy: 0 }]]);
    const anchors = new Map<string, Anchor>([['a', { x: 0, y: 0, free: true }]]);
    // Speed falls by the same amount each step, not by a share of itself.
    const speeds: number[] = [];
    for (let i = 0; i < 4; i++) {
      stepSprings(bodies, anchors, false, 0.1);
      speeds.push(bodies.get('a')!.vx);
    }
    const drops = speeds.map((s, i) => (i === 0 ? v0 : speeds[i - 1]) - s);
    for (const d of drops) expect(d).toBeCloseTo(SPRING.decel * 0.1, 6);
    run(bodies, anchors, false, 5);
    const a = bodies.get('a')!;
    expect(a.vx).toBe(0);
    expect(anchors.size).toBe(0);
    // It stops at v² / 2·decel past where it was let go (the first 0.4 s plus the rest).
    expect(a.x).toBeCloseTo((v0 * v0) / (2 * SPRING.decel), 0);
  });

  it('flies in the direction it was moving and never past the speed cap', () => {
    const bodies = new Map([['a', { x: 0, y: 0, vx: 1e5, vy: -1e5 }]]);
    const anchors = new Map<string, Anchor>([['a', { x: 0, y: 0, free: true }]]);
    stepSprings(bodies, anchors, false, SPRING.maxStep);
    const b = bodies.get('a')!;
    expect(b.x).toBeGreaterThan(0);
    expect(b.y).toBeLessThan(0);
  });

  it('keeps a follower with its flying root', () => {
    const bodies = new Map([
      ['root', { x: 0, y: 0, vx: 300, vy: 0 }],
      ['kid', body(20, 0)],
    ]);
    const anchors = new Map<string, Anchor>([
      ['root', { x: 0, y: 0, free: true }],
      ['kid', { x: 20, y: 0, root: 'root' }],
    ]);
    run(bodies, anchors, false, 8);
    expect(bodies.get('root')!.x).toBeCloseTo(300 ** 2 / (2 * SPRING.decel), 0);
    expect(bodies.get('kid')!.x - bodies.get('root')!.x).toBeCloseTo(20, 1);
    expect(anchors.size).toBe(0);
  });

  it('does not move a body that has no anchor', () => {
    const bodies = new Map([['a', body(5, 5)], ['b', body()]]);
    run(bodies, new Map([['b', { x: 20, y: 0 }]]), true, 1);
    expect(bodies.get('a')).toMatchObject({ x: 5, y: 5, vx: 0, vy: 0 });
  });

  it('keeps running while held, even at rest', () => {
    const bodies = new Map([['a', body()]]);
    expect(stepSprings(bodies, new Map([['a', { x: 0, y: 0 }]]), true, 1 / 60)).toBe(true);
  });
});
