/**
 * path-morph.ts
 *
 * Geometry engine for SVG path morphing.
 *
 * Added for this fork (not present upstream). Turns any SVG path into a
 * canonical sequence of cubic Bézier sub-paths so that two arbitrary paths can
 * be interpolated frame by frame.
 *
 * Pipeline:
 *   parseToSubPaths(d)  -> normalise every command into cubic segments
 *   prepareMorph(a, b)  -> align sub-path count / segment count / start point
 *   morphAt(pair, t)    -> produce interpolated geometry for a single frame
 *
 * Upstream: https://github.com/Yqnn/svg-path-editor (Apache-2.0)
 */

import { PathParser } from './path-parser';

export interface Pt {
  x: number;
  y: number;
}

export interface CubicSegment {
  c1: Pt;
  c2: Pt;
  p: Pt;
}

export interface SubPath {
  start: Pt;
  segments: CubicSegment[];
  closed: boolean;
}

export interface MorphPair {
  from: SubPath[];
  to: SubPath[];
}

const TAU = Math.PI * 2;

const pt = (x: number, y: number): Pt => ({ x, y });

const dist2 = (a: Pt, b: Pt): number => {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
};

const lerpPt = (a: Pt, b: Pt, t: number): Pt =>
  pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

const nearlyEqual = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

/* ------------------------------------------------------------------ *
 * Arc -> cubic Bézier
 * Implements the endpoint-to-centre conversion from SVG 1.1 appendix F.6.5,
 * then splits the sweep into slices of at most 90 degrees, each approximated
 * by one cubic. Max radial error for a 90 degree slice is ~0.027% of radius,
 * which is well below a screen pixel for typical icon sizes.
 * ------------------------------------------------------------------ */
export function arcToCubics(
  x1: number,
  y1: number,
  rxIn: number,
  ryIn: number,
  xAxisRotation: number,
  largeArc: boolean,
  sweep: boolean,
  x2: number,
  y2: number
): CubicSegment[] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);

  if (nearlyEqual(x1, x2) && nearlyEqual(y1, y2)) {
    return [];
  }
  if (nearlyEqual(rx, 0) || nearlyEqual(ry, 0)) {
    return [{ c1: pt(x1, y1), c2: pt(x2, y2), p: pt(x2, y2) }];
  }

  const phi = (xAxisRotation * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  const dx2 = (x1 - x2) / 2;
  const dy2 = (y1 - y2) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale radii up when they are too small to span the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  const rx2 = rx * rx;
  const ry2 = ry * ry;
  const x1p2 = x1p * x1p;
  const y1p2 = y1p * y1p;

  const numerator = rx2 * ry2 - rx2 * y1p2 - ry2 * x1p2;
  const denominator = rx2 * y1p2 + ry2 * x1p2;
  const sign = largeArc !== sweep ? 1 : -1;
  const coef =
    denominator === 0
      ? 0
      : sign * Math.sqrt(Math.max(0, numerator / denominator));

  const cxp = (coef * rx * y1p) / ry;
  const cyp = (-coef * ry * x1p) / rx;

  const cx = cosPhi * cxp - sinPhi * cyp + (x1 + x2) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y1 + y2) / 2;

  const ux = (x1p - cxp) / rx;
  const uy = (y1p - cyp) / ry;
  const vx = (-x1p - cxp) / rx;
  const vy = (-y1p - cyp) / ry;

  const theta1 = Math.atan2(uy, ux);
  let deltaTheta = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);

  if (!sweep && deltaTheta > 0) {
    deltaTheta -= TAU;
  } else if (sweep && deltaTheta < 0) {
    deltaTheta += TAU;
  }

  const sliceCount = Math.max(1, Math.ceil(Math.abs(deltaTheta) / (Math.PI / 2)));
  const delta = deltaTheta / sliceCount;
  const alpha = (4 / 3) * Math.tan(delta / 4);

  const pointAt = (t: number): Pt =>
    pt(
      cx + rx * cosPhi * Math.cos(t) - ry * sinPhi * Math.sin(t),
      cy + rx * sinPhi * Math.cos(t) + ry * cosPhi * Math.sin(t)
    );

  const derivativeAt = (t: number): Pt =>
    pt(
      -rx * cosPhi * Math.sin(t) - ry * sinPhi * Math.cos(t),
      -rx * sinPhi * Math.sin(t) + ry * cosPhi * Math.cos(t)
    );

  const result: CubicSegment[] = [];
  let t0 = theta1;
  for (let i = 0; i < sliceCount; i++) {
    const t1 = t0 + delta;
    const p0 = pointAt(t0);
    const p1 = pointAt(t1);
    const d0 = derivativeAt(t0);
    const d1 = derivativeAt(t1);

    const c1 = pt(p0.x + alpha * d0.x, p0.y + alpha * d0.y);
    const c2 = pt(p1.x - alpha * d1.x, p1.y - alpha * d1.y);

    result.push({ c1, c2, p: i === sliceCount - 1 ? pt(x2, y2) : p1 });
    t0 = t1;
  }

  return result;
}

/* ------------------------------------------------------------------ *
 * Parser: every SVG command -> cubic segments
 * ------------------------------------------------------------------ */
export function parseToSubPaths(d: string): SubPath[] {
  const source = (d || '').trim();
  if (!source) {
    return [];
  }

  // Re-use the upstream tokenizer so command grammar / number handling stays
  // byte-identical with the rest of the editor.
  const tokens: string[][] = PathParser.parse(source);

  const subPaths: SubPath[] = [];
  let current: SubPath | null = null;
  let cursor = pt(0, 0);
  let subStart = pt(0, 0);
  let prevCubicControl: Pt | null = null;
  let prevQuadControl: Pt | null = null;

  const ensureSubPath = (): SubPath => {
    if (!current) {
      current = { start: pt(cursor.x, cursor.y), segments: [], closed: false };
      subPaths.push(current);
    }
    return current;
  };

  for (const token of tokens) {
    const command = token[0];
    const rel = command !== command.toUpperCase();
    const type = command.toUpperCase();
    const v = token.slice(1).map(Number);
    const ox = rel ? cursor.x : 0;
    const oy = rel ? cursor.y : 0;

    let nextCubicControl: Pt | null = null;
    let nextQuadControl: Pt | null = null;

    switch (type) {
      case 'M': {
        cursor = pt(ox + v[0], oy + v[1]);
        subStart = pt(cursor.x, cursor.y);
        current = { start: pt(cursor.x, cursor.y), segments: [], closed: false };
        subPaths.push(current);
        break;
      }
      case 'L': {
        const target = pt(ox + v[0], oy + v[1]);
        ensureSubPath().segments.push({
          c1: pt(cursor.x, cursor.y),
          c2: pt(target.x, target.y),
          p: target
        });
        cursor = target;
        break;
      }
      case 'H': {
        const target = pt(ox + v[0], cursor.y);
        ensureSubPath().segments.push({
          c1: pt(cursor.x, cursor.y),
          c2: pt(target.x, target.y),
          p: target
        });
        cursor = target;
        break;
      }
      case 'V': {
        const target = pt(cursor.x, oy + v[0]);
        ensureSubPath().segments.push({
          c1: pt(cursor.x, cursor.y),
          c2: pt(target.x, target.y),
          p: target
        });
        cursor = target;
        break;
      }
      case 'C': {
        const c1 = pt(ox + v[0], oy + v[1]);
        const c2 = pt(ox + v[2], oy + v[3]);
        const target = pt(ox + v[4], oy + v[5]);
        ensureSubPath().segments.push({ c1, c2, p: target });
        nextCubicControl = c2;
        cursor = target;
        break;
      }
      case 'S': {
        const c1 =
          prevCubicControl
            ? pt(2 * cursor.x - prevCubicControl.x, 2 * cursor.y - prevCubicControl.y)
            : pt(cursor.x, cursor.y);
        const c2 = pt(ox + v[0], oy + v[1]);
        const target = pt(ox + v[2], oy + v[3]);
        ensureSubPath().segments.push({ c1, c2, p: target });
        nextCubicControl = c2;
        cursor = target;
        break;
      }
      case 'Q': {
        const q = pt(ox + v[0], oy + v[1]);
        const target = pt(ox + v[2], oy + v[3]);
        ensureSubPath().segments.push({
          c1: pt(cursor.x + (2 / 3) * (q.x - cursor.x), cursor.y + (2 / 3) * (q.y - cursor.y)),
          c2: pt(target.x + (2 / 3) * (q.x - target.x), target.y + (2 / 3) * (q.y - target.y)),
          p: target
        });
        nextQuadControl = q;
        cursor = target;
        break;
      }
      case 'T': {
        const q: Pt = prevQuadControl
          ? pt(2 * cursor.x - prevQuadControl.x, 2 * cursor.y - prevQuadControl.y)
          : pt(cursor.x, cursor.y);
        const target = pt(ox + v[0], oy + v[1]);
        ensureSubPath().segments.push({
          c1: pt(cursor.x + (2 / 3) * (q.x - cursor.x), cursor.y + (2 / 3) * (q.y - cursor.y)),
          c2: pt(target.x + (2 / 3) * (q.x - target.x), target.y + (2 / 3) * (q.y - target.y)),
          p: target
        });
        nextQuadControl = q;
        cursor = target;
        break;
      }
      case 'A': {
        const target = pt(ox + v[5], oy + v[6]);
        const cubics = arcToCubics(
          cursor.x,
          cursor.y,
          v[0],
          v[1],
          v[2],
          v[3] !== 0,
          v[4] !== 0,
          target.x,
          target.y
        );
        ensureSubPath().segments.push(...cubics);
        cursor = target;
        break;
      }
      case 'Z': {
        const sub = ensureSubPath();
        if (dist2(cursor, subStart) > 1e-12) {
          sub.segments.push({
            c1: pt(cursor.x, cursor.y),
            c2: pt(subStart.x, subStart.y),
            p: pt(subStart.x, subStart.y)
          });
        }
        sub.closed = true;
        cursor = pt(subStart.x, subStart.y);
        current = null;
        break;
      }
      default:
        break;
    }

    prevCubicControl = nextCubicControl;
    prevQuadControl = nextQuadControl;
  }

  return subPaths.filter((s) => s.segments.length > 0 || s.start);
}

/* ------------------------------------------------------------------ *
 * Serialisation
 * ------------------------------------------------------------------ */
const roundTo = (value: number, decimals: number): number => {
  const f = Math.pow(10, decimals);
  return Math.round(value * f) / f;
};

export function subPathsToPathData(subPaths: SubPath[], decimals = 3): string {
  const parts: string[] = [];
  for (const sub of subPaths) {
    if (!sub.segments.length) {
      continue;
    }
    parts.push(`M ${roundTo(sub.start.x, decimals)} ${roundTo(sub.start.y, decimals)}`);
    for (const seg of sub.segments) {
      parts.push(
        `C ${roundTo(seg.c1.x, decimals)} ${roundTo(seg.c1.y, decimals)} ` +
          `${roundTo(seg.c2.x, decimals)} ${roundTo(seg.c2.y, decimals)} ` +
          `${roundTo(seg.p.x, decimals)} ${roundTo(seg.p.y, decimals)}`
      );
    }
    if (sub.closed) {
      parts.push('Z');
    }
  }
  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Normalisation
 * ------------------------------------------------------------------ */

/** Reverse the drawing direction of a sub-path. Geometry is unchanged. */
function reverseSubPath(sub: SubPath): SubPath {
  const points: Pt[] = [sub.start, ...sub.segments.map((s) => s.p)];
  const segments: CubicSegment[] = sub.segments
    .map((seg, k) => ({ seg, k }))
    .reverse()
    .map(({ seg, k }) => ({
      c1: pt(seg.c2.x, seg.c2.y),
      c2: pt(seg.c1.x, seg.c1.y),
      p: pt(points[k].x, points[k].y)
    }));
  const start = points[points.length - 1];
  return { start: pt(start.x, start.y), segments, closed: sub.closed };
}

/** Rotate the segment order of a closed sub-path so it starts later. */
function rotateSubPath(sub: SubPath, offset: number): SubPath {
  const n = sub.segments.length;
  if (!n || offset % n === 0) {
    return sub;
  }
  const k = ((offset % n) + n) % n;
  const segments = [...sub.segments.slice(k), ...sub.segments.slice(0, k)];
  const start = k === 0 ? sub.start : sub.segments[k - 1].p;
  return { start: pt(start.x, start.y), segments, closed: sub.closed };
}

/** Flatten a sub-path into a comparable point list. */
function flattenSubPath(sub: SubPath): Pt[] {
  const out: Pt[] = [sub.start];
  for (const seg of sub.segments) {
    out.push(seg.c1, seg.c2, seg.p);
  }
  return out;
}

function pairCost(a: SubPath, b: SubPath): number {
  const pa = flattenSubPath(a);
  const pb = flattenSubPath(b);
  let sum = 0;
  for (let i = 0; i < pa.length; i++) {
    sum += dist2(pa[i], pb[i]);
    if (sum > 1e12) {
      return sum;
    }
  }
  return sum;
}

/**
 * Pick the rotation / direction of `sub` that best matches `reference`.
 * For closed paths every rotation is a valid starting point, so we can search
 * all of them; the cheapest alignment avoids the "twisting" artefact you get
 * when the first anchor of A lands opposite its counterpart in B.
 */
function alignSubPath(sub: SubPath, reference: SubPath): SubPath {
  const n = sub.segments.length;
  const maxCandidates = n > 256 ? 32 : n;
  const stride = n > 256 ? Math.max(1, Math.floor(n / 32)) : 1;

  let best = sub;
  let bestCost = Infinity;

  const consider = (candidate: SubPath) => {
    const cost = pairCost(candidate, reference);
    if (cost < bestCost) {
      bestCost = cost;
      best = candidate;
    }
  };

  consider(sub);
  consider(reverseSubPath(sub));

  if (sub.closed) {
    for (let i = stride; i < maxCandidates; i += stride) {
      consider(rotateSubPath(sub, i));
      consider(rotateSubPath(reverseSubPath(sub), i));
    }
  }

  return best;
}

/** Pad a sub-path with zero-length segments until it reaches `count`. */
function padSegments(sub: SubPath, count: number): SubPath {
  if (sub.segments.length >= count) {
    return sub;
  }
  const last = sub.segments.length
    ? sub.segments[sub.segments.length - 1].p
    : sub.start;
  const segments = [...sub.segments];
  while (segments.length < count) {
    segments.push({ c1: pt(last.x, last.y), c2: pt(last.x, last.y), p: pt(last.x, last.y) });
  }
  return { start: pt(sub.start.x, sub.start.y), segments, closed: sub.closed };
}

/** A degenerate sub-path that collapses onto a single point. */
function collapsedSubPath(anchor: Pt): SubPath {
  return {
    start: pt(anchor.x, anchor.y),
    segments: [{ c1: pt(anchor.x, anchor.y), c2: pt(anchor.x, anchor.y), p: pt(anchor.x, anchor.y) }],
    closed: false
  };
}

/** Last point of a sub-path. */
function endOf(sub: SubPath): Pt {
  return sub.segments.length ? sub.segments[sub.segments.length - 1].p : sub.start;
}

/**
 * Build a morph-ready pair: same number of sub-paths, same number of segments
 * per sub-path, and best-effort start-point alignment.
 */
export function prepareMorph(fromD: string, toD: string): MorphPair {
  const rawFrom = parseToSubPaths(fromD);
  const rawTo = parseToSubPaths(toD);

  const from = rawFrom.map((s) => ({ ...s }));
  const to = rawTo.map((s) => ({ ...s }));

  // 1. Equalise sub-path count by collapsing extras onto the last anchor.
  const fromAnchor = from.length ? endOf(from[from.length - 1]) : pt(0, 0);
  const toAnchor = to.length ? endOf(to[to.length - 1]) : pt(0, 0);
  while (from.length < to.length) {
    from.push(collapsedSubPath(to[from.length].start));
  }
  while (to.length < from.length) {
    to.push(collapsedSubPath(from[to.length].start));
  }

  // 2. Equalise segment count per sub-path.
  for (let i = 0; i < from.length; i++) {
    const count = Math.max(from[i].segments.length, to[i].segments.length, 1);
    from[i] = padSegments(from[i], count);
    to[i] = padSegments(to[i], count);
  }

  // 3. Align start point / direction of `to` against `from`.
  for (let i = 0; i < to.length; i++) {
    to[i] = alignSubPath(to[i], from[i]);
  }

  // Empty input on either side: collapse everything onto one anchor.
  if (!from.length && !to.length) {
    return { from: [], to: [] };
  }
  if (!from.length) {
    return { from: to.map(() => collapsedSubPath(fromAnchor)), to };
  }
  if (!to.length) {
    return { from, to: from.map(() => collapsedSubPath(toAnchor)) };
  }

  return { from, to };
}

/* ------------------------------------------------------------------ *
 * Interpolation
 * ------------------------------------------------------------------ */
export function morphAt(pair: MorphPair, t: number): SubPath[] {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const out: SubPath[] = [];

  for (let i = 0; i < pair.from.length; i++) {
    const a = pair.from[i];
    const b = pair.to[i] || a;
    const segments: CubicSegment[] = [];

    for (let j = 0; j < a.segments.length; j++) {
      const sa = a.segments[j];
      const sb = b.segments[j] || sa;
      segments.push({
        c1: lerpPt(sa.c1, sb.c1, clamped),
        c2: lerpPt(sa.c2, sb.c2, clamped),
        p: lerpPt(sa.p, sb.p, clamped)
      });
    }

    out.push({
      start: lerpPt(a.start, b.start, clamped),
      segments,
      closed: clamped < 0.5 ? a.closed : b.closed
    });
  }

  return out;
}

/**
 * Fused interpolate + serialise. Avoids allocating an intermediate SubPath
 * tree and halves the number of string joins per frame; this is the hot path
 * during playback so it is worth specialising.
 */
export function morphPathData(pair: MorphPair, t: number, decimals = 3): string {
  const clamped = t < 0 ? 0 : t > 1 ? 1 : t;
  const f = Math.pow(10, decimals);
  const r = (v: number): number => Math.round(v * f) / f;
  const parts: string[] = [];

  for (let i = 0; i < pair.from.length; i++) {
    const a = pair.from[i];
    const b = pair.to[i] || a;
    if (!a.segments.length) {
      continue;
    }

    parts.push(
      `M ${r(a.start.x + (b.start.x - a.start.x) * clamped)} ${r(
        a.start.y + (b.start.y - a.start.y) * clamped
      )}`
    );

    for (let j = 0; j < a.segments.length; j++) {
      const sa = a.segments[j];
      const sb = b.segments[j] || sa;
      parts.push(
        `C ${r(sa.c1.x + (sb.c1.x - sa.c1.x) * clamped)} ${r(sa.c1.y + (sb.c1.y - sa.c1.y) * clamped)} ` +
          `${r(sa.c2.x + (sb.c2.x - sa.c2.x) * clamped)} ${r(sa.c2.y + (sb.c2.y - sa.c2.y) * clamped)} ` +
          `${r(sa.p.x + (sb.p.x - sa.p.x) * clamped)} ${r(sa.p.y + (sb.p.y - sa.p.y) * clamped)}`
      );
    }

    if (clamped < 0.5 ? a.closed : b.closed) {
      parts.push('Z');
    }
  }

  return parts.join(' ');
}

/* ------------------------------------------------------------------ *
 * Easing
 * ------------------------------------------------------------------ */
export type EasingName =
  | 'linear'
  | 'easeInQuad'
  | 'easeOutQuad'
  | 'easeInOutQuad'
  | 'easeInCubic'
  | 'easeOutCubic'
  | 'easeInOutCubic'
  | 'easeOutBack'
  | 'easeInOutSine';

export const EASINGS: Record<EasingName, (t: number) => number> = {
  linear: (t) => t,
  easeInQuad: (t) => t * t,
  easeOutQuad: (t) => t * (2 - t),
  easeInOutQuad: (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t),
  easeInCubic: (t) => t * t * t,
  easeOutCubic: (t) => 1 - Math.pow(1 - t, 3),
  easeInOutCubic: (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2),
  easeOutBack: (t) => {
    const c1 = 1.70158;
    const c3 = c1 + 1;
    return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
  },
  easeInOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2
};

export const EASING_LABELS: Record<EasingName, string> = {
  linear: 'Linear',
  easeInQuad: 'Ease in',
  easeOutQuad: 'Ease out',
  easeInOutQuad: 'Ease in-out',
  easeInCubic: 'Cubic in',
  easeOutCubic: 'Cubic out',
  easeInOutCubic: 'Cubic in-out',
  easeOutBack: 'Back out',
  easeInOutSine: 'Sine in-out'
};

export function applyEasing(name: EasingName, t: number): number {
  const fn = EASINGS[name] || EASINGS.linear;
  return fn(t < 0 ? 0 : t > 1 ? 1 : t);
}

/* ------------------------------------------------------------------ *
 * Sampling helper (used by the SVG/SMIL exporter)
 * ------------------------------------------------------------------ */
export interface Keyframe {
  path: string;
  easing: EasingName;
  duration: number;
}

/**
 * Resolve the global progress of `keyframes` at `elapsed` ms.
 * Returns both the active segment index and the eased local progress.
 */
export function resolveTimeline(
  keyframes: Keyframe[],
  elapsed: number
): { index: number; local: number } {
  if (keyframes.length < 2) {
    return { index: 0, local: 0 };
  }

  const total = keyframes.slice(1).reduce((acc, k) => acc + Math.max(0, k.duration), 0);
  if (total <= 0) {
    return { index: 0, local: 0 };
  }

  let time = elapsed % total;
  if (time < 0) {
    time += total;
  }

  for (let i = 1; i < keyframes.length; i++) {
    const duration = Math.max(0, keyframes[i].duration);
    if (time < duration || i === keyframes.length - 1) {
      const local = duration > 0 ? time / duration : 1;
      return { index: i - 1, local: local < 0 ? 0 : local > 1 ? 1 : local };
    }
    time -= duration;
  }

  return { index: keyframes.length - 2, local: 1 };
}
