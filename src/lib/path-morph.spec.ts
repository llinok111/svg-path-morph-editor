import {
  applyEasing,
  arcToCubics,
  EASINGS,
  morphAt,
  morphPathData,
  parseToSubPaths,
  prepareMorph,
  resolveTimeline,
  subPathsToPathData,
  Keyframe
} from './path-morph';

const near = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) < eps;

const cubicAt = (
  p0: { x: number; y: number },
  c1: { x: number; y: number },
  c2: { x: number; y: number },
  p1: { x: number; y: number },
  t: number
) => {
  const mt = 1 - t;
  const a = mt * mt * mt;
  const b = 3 * mt * mt * t;
  const c = 3 * mt * t * t;
  const d = t * t * t;
  return {
    x: a * p0.x + b * c1.x + c * c2.x + d * p1.x,
    y: a * p0.y + b * c1.y + c * c2.y + d * p1.y
  };
};

describe('arcToCubics', () => {
  it('should start and end exactly on the arc endpoints', () => {
    const segments = arcToCubics(0, 0, 50, 50, 0, false, true, 100, 0);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[segments.length - 1].p.x).toBeCloseTo(100, 10);
    expect(segments[segments.length - 1].p.y).toBeCloseTo(0, 10);
  });

  it('should keep every sampled point within 0.05% of the true radius', () => {
    const r = 80;
    const segments = arcToCubics(0, 0, r, r, 0, false, true, r * 2, 0);
    let cursor = { x: 0, y: 0 };
    for (const seg of segments) {
      for (let i = 0; i <= 10; i++) {
        const p = cubicAt(cursor, seg.c1, seg.c2, seg.p, i / 10);
        const radius = Math.hypot(p.x - r, p.y);
        expect(Math.abs(radius - r) / r).toBeLessThan(0.0005);
      }
      cursor = seg.p;
    }
  });

  it('should split a full sweep into 90-degree-or-smaller slices', () => {
    const segments = arcToCubics(0, 0, 40, 40, 0, true, true, 0, 0.0001);
    // Near-full circle -> 4 slices.
    expect(segments.length).toBe(4);
  });

  it('should degrade a zero-radius arc to a straight line', () => {
    const segments = arcToCubics(0, 0, 0, 0, 0, false, true, 10, 10);
    expect(segments).toEqual([
      { c1: { x: 0, y: 0 }, c2: { x: 10, y: 10 }, p: { x: 10, y: 10 } }
    ]);
  });

  it('should scale up radii that are too small to span the endpoints', () => {
    const segments = arcToCubics(0, 0, 1, 1, 0, false, true, 100, 0);
    expect(segments.length).toBeGreaterThan(0);
    expect(segments[segments.length - 1].p.x).toBeCloseTo(100, 8);
  });

  it('should honour the large-arc and sweep flags', () => {
    const sweepPositive = arcToCubics(0, 0, 50, 50, 0, false, true, 100, 0);
    const sweepNegative = arcToCubics(0, 0, 50, 50, 0, false, false, 100, 0);
    // Opposite sweep must bend to the other side of the chord.
    const midPositive = cubicAt(
      { x: 0, y: 0 },
      sweepPositive[0].c1,
      sweepPositive[0].c2,
      sweepPositive[0].p,
      0.5
    );
    const midNegative = cubicAt(
      { x: 0, y: 0 },
      sweepNegative[0].c1,
      sweepNegative[0].c2,
      sweepNegative[0].p,
      0.5
    );
    expect(Math.sign(midPositive.y)).toBe(-Math.sign(midNegative.y));
  });
});

describe('parseToSubPaths', () => {
  it('should return no sub-paths for an empty string', () => {
    expect(parseToSubPaths('')).toEqual([]);
    expect(parseToSubPaths('   ')).toEqual([]);
  });

  it('should convert a polyline into cubic segments with exact endpoints', () => {
    const subPaths = parseToSubPaths('M 0 0 L 10 0 L 10 10');
    expect(subPaths.length).toBe(1);
    expect(subPaths[0].segments.length).toBe(2);
    expect(subPaths[0].segments[1].p).toEqual({ x: 10, y: 10 });
  });

  it('should resolve relative commands against the running cursor', () => {
    const subPaths = parseToSubPaths('M 5 5 l 5 0 l 0 5');
    expect(subPaths[0].segments[0].p).toEqual({ x: 10, y: 5 });
    expect(subPaths[0].segments[1].p).toEqual({ x: 10, y: 10 });
  });

  it('should expand H and V into explicit segments', () => {
    const subPaths = parseToSubPaths('M 0 0 H 20 V 20');
    expect(subPaths[0].segments[0].p).toEqual({ x: 20, y: 0 });
    expect(subPaths[0].segments[1].p).toEqual({ x: 20, y: 20 });
  });

  it('should convert a quadratic to an equivalent cubic', () => {
    const subPaths = parseToSubPaths('M 0 0 Q 10 20 20 0');
    const seg = subPaths[0].segments[0];
    // Quadratic -> cubic control points sit at 1/3 and 2/3 toward the control.
    expect(seg.c1.x).toBeCloseTo(20 / 3, 8);
    expect(seg.c1.y).toBeCloseTo(40 / 3, 8);
    expect(seg.c2.x).toBeCloseTo(20 - 20 / 3, 8);
    expect(seg.c2.y).toBeCloseTo(40 / 3, 8);
  });

  it('should mirror control points for S after a C', () => {
    const subPaths = parseToSubPaths('M 0 0 C 0 10 10 10 10 0 S 20 -10 20 0');
    const seg = subPaths[0].segments[1];
    // Reflection of (10,10) about (10,0) is (10,-10).
    expect(seg.c1.x).toBeCloseTo(10, 8);
    expect(seg.c1.y).toBeCloseTo(-10, 8);
  });

  it('should mirror control points for T after a Q', () => {
    const subPaths = parseToSubPaths('M 0 0 Q 5 10 10 0 T 20 0');
    const seg = subPaths[0].segments[1];
    // Reflection of (5,10) about (10,0) is (15,-10).
    expect(seg.c1.x).toBeCloseTo(10 + (2 / 3) * (15 - 10), 8);
    expect(seg.c1.y).toBeCloseTo((2 / 3) * -10, 8);
  });

  it('should close a sub-path with an explicit segment', () => {
    const subPaths = parseToSubPaths('M 0 0 L 10 0 L 10 10 Z');
    expect(subPaths[0].closed).toBe(true);
    expect(subPaths[0].segments.length).toBe(3);
    expect(subPaths[0].segments[2].p).toEqual({ x: 0, y: 0 });
  });

  it('should not add a closing segment when already at the start point', () => {
    const subPaths = parseToSubPaths('M 0 0 L 10 0 L 0 0 Z');
    expect(subPaths[0].segments.length).toBe(2);
    expect(subPaths[0].closed).toBe(true);
  });

  it('should split multiple sub-paths', () => {
    const subPaths = parseToSubPaths('M 0 0 L 10 0 M 20 20 L 30 30');
    expect(subPaths.length).toBe(2);
    expect(subPaths[1].start).toEqual({ x: 20, y: 20 });
  });

  it('should expand arcs into cubics inside a path', () => {
    const subPaths = parseToSubPaths('M 0 0 A 10 10 0 0 1 20 0');
    expect(subPaths[0].segments.length).toBeGreaterThanOrEqual(2);
    expect(subPaths[0].segments[subPaths[0].segments.length - 1].p.x).toBeCloseTo(20, 8);
  });

  it('should survive the upstream default path without throwing', () => {
    const d =
      'M 4 8 L 10 1 L 13 0 L 12 3 L 5 9 C 6 10 6 11 7 10 C 7 11 8 12 7 12 ' +
      'A 1.42 1.42 0 0 1 6 13 A 5 5 0 0 0 4 10 Q 3.5 9.9 3.5 10.5 T 2 11.8 ' +
      'T 1.2 11 T 2.5 9.5 T 3 9 A 5 5 90 0 0 0 7 A 1.42 1.42 0 0 1 1 6 ' +
      'C 1 5 2 6 3 6 C 2 7 3 7 4 8 M 10 1 L 10 3 L 12 3 L 10.2 2.8 L 10 1';
    const subPaths = parseToSubPaths(d);
    expect(subPaths.length).toBe(2);
    expect(subPaths[0].segments.length).toBeGreaterThan(10);
  });
});

describe('subPathsToPathData', () => {
  it('should round-trip a simple path through the canonical form', () => {
    const subPaths = parseToSubPaths('M 0 0 L 10 0 L 10 10 Z');
    const d = subPathsToPathData(subPaths);
    const again = parseToSubPaths(d);
    expect(again[0].segments.length).toBe(subPaths[0].segments.length);
    expect(again[0].segments[1].p).toEqual({ x: 10, y: 10 });
    expect(again[0].closed).toBe(true);
  });

  it('should respect the requested precision', () => {
    const subPaths = parseToSubPaths('M 0 0 L 1.23456 0');
    expect(subPathsToPathData(subPaths, 2)).toContain('1.23');
    // A straight line keeps its start point as the first control point.
    expect(subPathsToPathData(subPaths, 0)).toContain('C 0 0 1 0 1 0');
  });
});

describe('prepareMorph', () => {
  it('should equalise the number of sub-paths', () => {
    const pair = prepareMorph('M 0 0 L 10 0', 'M 0 0 L 10 0 M 20 20 L 30 30 M 40 40 L 50 50');
    expect(pair.from.length).toBe(3);
    expect(pair.to.length).toBe(3);
  });

  it('should equalise segments within each sub-path', () => {
    const pair = prepareMorph('M 0 0 L 10 0', 'M 0 0 C 1 1 2 2 10 0 C 3 3 4 4 20 0');
    expect(pair.from[0].segments.length).toBe(2);
    expect(pair.to[0].segments.length).toBe(2);
  });

  it('should pad with zero-length segments so the shape does not drift', () => {
    const pair = prepareMorph('M 0 0 L 10 0', 'M 0 0 L 10 0 L 10 10');
    const padded = pair.from[0].segments[1];
    expect(padded.p).toEqual({ x: 10, y: 0 });
    expect(padded.c1).toEqual({ x: 10, y: 0 });
    expect(padded.c2).toEqual({ x: 10, y: 0 });
  });

  it('should collapse extra sub-paths onto a point instead of dropping them', () => {
    const pair = prepareMorph('M 0 0 L 10 0', 'M 0 0 L 10 0 M 50 50 L 60 60');
    const collapsed = pair.from[1];
    expect(collapsed.segments.length).toBe(1);
    expect(collapsed.start).toEqual(collapsed.segments[0].p);
  });

  it('should align the start point of a closed path to minimise travel', () => {
    // A square and the same square rotated by two corners: the optimal start
    // point is the corner closest to the source, not the literal first one.
    const square = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
    const rotated = 'M 10 10 L 0 10 L 0 0 L 10 0 Z';
    const pair = prepareMorph(square, rotated);

    let travel = 0;
    const start = pair.to[0].start;
    travel += Math.hypot(start.x - pair.from[0].start.x, start.y - pair.from[0].start.y);
    expect(travel).toBeLessThan(1e-6);
  });

  it('should handle an empty source by collapsing the target', () => {
    const pair = prepareMorph('', 'M 0 0 L 10 0');
    expect(pair.from.length).toBe(1);
    expect(pair.from[0].start).toEqual(pair.from[0].segments[0].p);
    expect(pair.to.length).toBe(1);
  });

  it('should handle an empty target by collapsing the source', () => {
    const pair = prepareMorph('M 0 0 L 10 0', '');
    expect(pair.to.length).toBe(1);
    expect(pair.to[0].start).toEqual(pair.to[0].segments[0].p);
  });

  it('should return an empty pair when both sides are empty', () => {
    const pair = prepareMorph('', '');
    expect(pair.from).toEqual([]);
    expect(pair.to).toEqual([]);
  });

  it('should be symmetric in segment counts', () => {
    const a = 'M 0 0 L 10 0 L 10 10 L 0 10 Z';
    const b = 'M 5 5 A 5 5 0 1 1 4.9 5 Z';
    const ab = prepareMorph(a, b);
    const ba = prepareMorph(b, a);
    expect(ab.from[0].segments.length).toBe(ab.to[0].segments.length);
    expect(ba.from[0].segments.length).toBe(ba.to[0].segments.length);
  });
});

describe('morphAt', () => {
  const pair = prepareMorph('M 0 0 L 10 0', 'M 0 0 L 0 10');

  it('should return the source geometry at t=0', () => {
    const subPaths = morphAt(pair, 0);
    expect(subPaths[0].segments[0].p.x).toBeCloseTo(10, 8);
    expect(subPaths[0].segments[0].p.y).toBeCloseTo(0, 8);
  });

  it('should return the target geometry at t=1', () => {
    const subPaths = morphAt(pair, 1);
    expect(subPaths[0].segments[0].p.x).toBeCloseTo(0, 8);
    expect(subPaths[0].segments[0].p.y).toBeCloseTo(10, 8);
  });

  it('should interpolate linearly at the midpoint', () => {
    const subPaths = morphAt(pair, 0.5);
    expect(subPaths[0].segments[0].p.x).toBeCloseTo(5, 8);
    expect(subPaths[0].segments[0].p.y).toBeCloseTo(5, 8);
  });

  it('should clamp out-of-range progress', () => {
    expect(morphAt(pair, -3)[0].segments[0].p.x).toBeCloseTo(10, 8);
    expect(morphAt(pair, 4)[0].segments[0].p.y).toBeCloseTo(10, 8);
  });

  it('should preserve the endpoint count of the prepared pair', () => {
    const a = morphAt(pair, 0.37);
    expect(a[0].segments.length).toBe(pair.from[0].segments.length);
  });

  it('should keep control points finite throughout the transition', () => {
    const complexPair = prepareMorph(
      'M 4 8 L 10 1 L 13 0 L 12 3 L 5 9 C 6 10 6 11 7 10 Z',
      'M 0 0 A 20 20 0 1 1 0.01 0 Q 10 20 20 0 T 30 0 Z'
    );
    for (let i = 0; i <= 20; i++) {
      const frame = morphAt(complexPair, i / 20);
      for (const sub of frame) {
        expect(Number.isFinite(sub.start.x)).toBe(true);
        for (const seg of sub.segments) {
          expect(Number.isFinite(seg.c1.x)).toBe(true);
          expect(Number.isFinite(seg.c2.y)).toBe(true);
          expect(Number.isFinite(seg.p.x)).toBe(true);
        }
      }
    }
  });
});

describe('morphPathData', () => {
  it('should emit parseable path data for any progress value', () => {
    const pair = prepareMorph('M 0 0 L 10 0 L 10 10 Z', 'M 0 0 A 5 5 0 1 1 0.01 0 Z');
    for (const t of [0, 0.13, 0.5, 0.87, 1]) {
      const d = morphPathData(pair, t);
      expect(d.startsWith('M')).toBe(true);
      expect(() => parseToSubPaths(d)).not.toThrow();
    }
  });
});

describe('easing', () => {
  const names = Object.keys(EASINGS) as (keyof typeof EASINGS)[];

  it('should map 0 to 0 and 1 to 1 for every easing', () => {
    for (const name of names) {
      expect(applyEasing(name, 0)).toBeCloseTo(0, 6);
      expect(applyEasing(name, 1)).toBeCloseTo(1, 6);
    }
  });

  it('should clamp out-of-range inputs', () => {
    for (const name of names) {
      expect(applyEasing(name, -2)).toBeCloseTo(0, 6);
      expect(applyEasing(name, 3)).toBeCloseTo(1, 6);
    }
  });

  it('should stay within a sane numeric range', () => {
    for (const name of names) {
      for (let i = 0; i <= 100; i++) {
        const v = applyEasing(name, i / 100);
        expect(Number.isFinite(v)).toBe(true);
        // easeOutBack overshoots by design; allow its documented 10% overshoot.
        expect(v).toBeGreaterThan(-0.2);
        expect(v).toBeLessThan(1.2);
      }
    }
  });

  it('should make easeIn slower than linear at the midpoint', () => {
    expect(applyEasing('easeInQuad', 0.5)).toBeLessThan(0.5);
    expect(applyEasing('easeOutQuad', 0.5)).toBeGreaterThan(0.5);
  });

  it('should fall back to linear for an unknown easing name', () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(applyEasing('nope' as any, 0.4)).toBeCloseTo(0.4, 8);
  });
});

describe('resolveTimeline', () => {
  const kf = (durations: number[]): Keyframe[] =>
    durations.map((duration, i) => ({
      path: `M 0 0 L ${i + 1} 0`,
      easing: 'linear' as const,
      duration
    }));

  it('should return the first segment at time 0', () => {
    const r = resolveTimeline(kf([0, 100, 100]), 0);
    expect(r.index).toBe(0);
    expect(r.local).toBeCloseTo(0, 8);
  });

  it('should report the midpoint of the first transition', () => {
    const r = resolveTimeline(kf([0, 100, 100]), 50);
    expect(r.index).toBe(0);
    expect(r.local).toBeCloseTo(0.5, 8);
  });

  it('should advance to the second transition', () => {
    const r = resolveTimeline(kf([0, 100, 100]), 150);
    expect(r.index).toBe(1);
    expect(r.local).toBeCloseTo(0.5, 8);
  });

  it('should loop past the total duration', () => {
    const r = resolveTimeline(kf([0, 100, 100]), 250);
    expect(r.index).toBe(0);
    expect(r.local).toBeCloseTo(0.5, 8);
  });

  it('should handle a single keyframe without dividing by zero', () => {
    const r = resolveTimeline(kf([0]), 999);
    expect(r.index).toBe(0);
    expect(r.local).toBe(0);
  });

  it('should handle zero total duration', () => {
    const r = resolveTimeline(kf([0, 0, 0]), 123);
    expect(r.index).toBe(0);
    expect(r.local).toBe(0);
  });

  it('should handle negative elapsed time', () => {
    const r = resolveTimeline(kf([0, 100]), -50);
    expect(r.index).toBe(0);
    expect(near(r.local, 0.5, 1e-9)).toBe(true);
  });
});
