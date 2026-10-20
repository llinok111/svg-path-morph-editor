import {
  applyEasing,
  EASING_LABELS,
  Keyframe,
  morphPathData,
  prepareMorph,
  resolveTimeline
} from './path-morph';

/**
 * Exporters for the morph timeline. Added for this fork.
 *
 * Two formats:
 *  - SVG with SMIL <animate> using pre-sampled keyTimes/keySplines-free
 *    values. SMIL path animation can't ease arbitrarily, so we bake the easing
 *    into the sample distribution instead.
 *  - Self-contained HTML that ships the same geometry engine and drives it
 *    with rAF, giving exact parity with the editor preview.
 */

const round = (n: number, d = 3): string => {
  const f = Math.pow(10, d);
  return String(Math.round(n * f) / f);
};

/** Compute the bounding box of every keyframe, padded a little. */
function boundingBox(paths: string[]): { x: number; y: number; w: number; h: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const d of paths) {
    const pair = prepareMorph(d, d);
    for (const sub of pair.from) {
      const pts = [sub.start, ...sub.segments.flatMap((s) => [s.c1, s.c2, s.p])];
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.x > maxX) maxX = p.x;
        if (p.y > maxY) maxY = p.y;
      }
    }
  }

  if (!Number.isFinite(minX)) {
    return { x: 0, y: 0, w: 100, h: 100 };
  }

  const pad = Math.max((maxX - minX), (maxY - minY)) * 0.08 || 2;
  return {
    x: minX - pad,
    y: minY - pad,
    w: Math.max(maxX - minX + pad * 2, 1),
    h: Math.max(maxY - minY + pad * 2, 1)
  };
}

/**
 * Build an SVG whose path morphs through every keyframe using SMIL.
 * `samplesPerSecond` controls temporal resolution: easing is baked into the
 * sample timings, so higher values mean smoother acceleration curves.
 */
export function exportSvgAnimation(
  keyframes: Keyframe[],
  options: {
    loop?: boolean;
    samplesPerSecond?: number;
    stroke?: string;
    fill?: string;
    strokeWidth?: number;
    /** Rendered pixel size of the longer edge. Defaults to 640. */
    size?: number;
  } = {}
): string {
  const loop = options.loop !== false;
  const sps = Math.max(6, Math.min(options.samplesPerSecond ?? 30, 60));
  const stroke = options.stroke || '#1a1a1a';
  const fill = options.fill || 'none';
  const size = Math.max(64, options.size ?? 640);

  const usable = keyframes.filter((k) => (k.path || '').trim());
  if (usable.length < 2) {
    throw new Error('At least two keyframes are required to export an animation.');
  }

  const box = boundingBox(usable.map((k) => k.path));

  // Scale the stroke so it keeps a constant optical weight regardless of the
  // user coordinate space: ~1% of the longer edge, clamped to a sane band.
  // With a 640px canvas this lands around 6-7 rendered pixels.
  const strokeWidth =
    options.strokeWidth ?? Math.min(Math.max(Math.max(box.w, box.h) * 0.01, 0.15), 4);

  // Fit the longer edge to `size`, preserving aspect ratio.
  const width = box.w >= box.h ? size : Math.round((size * box.w) / box.h);
  const height = box.w >= box.h ? Math.round((size * box.h) / box.w) : size;
  const pairs = usable.slice(1).map((k, i) => ({
    pair: prepareMorph(usable[i].path, usable[i + 1].path),
    easing: usable[i + 1].easing,
    duration: Math.max(1, usable[i + 1].duration)
  }));

  const total = pairs.reduce((acc, p) => acc + p.duration, 0);

  // Bake easing into sample timing: for each segment we emit `n` samples at
  // evenly spaced *output* timestamps and evaluate the eased progress.
  const values: string[] = [];
  const keyTimes: string[] = [];
  let elapsed = 0;

  pairs.forEach((seg, segIndex) => {
    const frames = Math.max(2, Math.round((seg.duration / 1000) * sps));
    for (let f = 0; f <= frames; f++) {
      const local = f / frames;
      if (segIndex > 0 && f === 0) {
        continue; // avoid duplicating the boundary sample
      }
      const eased = applyEasing(seg.easing, local);
      values.push(morphPathData(seg.pair, eased, 2));
      keyTimes.push(round((elapsed + local * seg.duration) / total, 5));
    }
    elapsed += seg.duration;
  });

  // SMIL requires the last keyTime to be exactly 1.
  keyTimes[keyTimes.length - 1] = '1';

  const dur = `${round(total / 1000, 3)}s`;
  const repeat = loop ? 'indefinite' : '1';
  const startPath = values[0];

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(box.x, 2)} ${round(box.y, 2)} ${round(box.w, 2)} ${round(box.h, 2)}" width="${width}" height="${height}" role="img" aria-label="Morphing shape animation">
  <title>Morph animation</title>
  <path d="${startPath}" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round">
    <animate
      attributeName="d"
      dur="${dur}"
      repeatCount="${repeat}"
      calcMode="linear"
      keyTimes="${keyTimes.join(';')}"
      values="${values.join(';')}"
    />
  </path>
</svg>
`;
}

/**
 * Self-contained HTML player. Embeds the same geometry engine (minified by
 * hand, dependency-free) so the exported file needs no build step and no
 * network access.
 */
export function exportHtmlPlayer(
  keyframes: Keyframe[],
  options: { loop?: boolean; background?: string; stroke?: string; fill?: string; strokeWidth?: number } = {}
): string {
  const loop = options.loop !== false;
  const background = options.background || '#faf7f2';
  const stroke = options.stroke || '#1a1a1a';
  const fill = options.fill || 'none';

  const usable = keyframes.filter((k) => (k.path || '').trim());
  if (usable.length < 2) {
    throw new Error('At least two keyframes are required to export an animation.');
  }

  const box = boundingBox(usable.map((k) => k.path));
  const strokeWidth =
    options.strokeWidth ?? Math.min(Math.max(Math.max(box.w, box.h) * 0.01, 0.15), 4);
  const payload = JSON.stringify({
    keyframes: usable.map((k) => ({ path: k.path, easing: k.easing, duration: k.duration })),
    loop,
    stroke,
    fill,
    strokeWidth
  }).replace(/</g, '\\u003c');

  const easingTable = JSON.stringify(EASING_LABELS);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Path morph animation</title>
<style>
  :root { color-scheme: light; }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    background: ${background};
    font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  .stage { width: min(90vw, 720px); max-height: 90vh; display: flex; flex-direction: column; gap: 14px; }
  svg { width: 100%; height: auto; display: block; }
  .bar { display: flex; align-items: center; gap: 12px; }
  button {
    width: 40px; height: 40px; border-radius: 50%;
    border: 1px solid #d8d2c6; background: #fff; color: #1a1a1a;
    cursor: pointer; display: grid; place-items: center; padding: 0;
    transition: background-color 140ms ease, transform 140ms ease;
  }
  button:hover { background: #f1ece2; transform: translateY(-1px); }
  button:active { transform: translateY(0); }
  button svg { width: 16px; height: 16px; }
  input[type="range"] { flex: 1; accent-color: #b5793a; height: 20px; }
  .time { font-variant-numeric: tabular-nums; font-size: 12px; color: #6d6459; min-width: 86px; text-align: right; }
  .caption { font-size: 12px; color: #8a8175; text-align: center; }
  @media (prefers-reduced-motion: reduce) { button { transition: none; } }
</style>
</head>
<body>
<div class="stage">
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="${round(box.x, 2)} ${round(box.y, 2)} ${round(box.w, 2)} ${round(box.h, 2)}" role="img" aria-label="Morphing shape animation">
    <path id="shape" d="" fill="${fill}" stroke="${stroke}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"></path>
  </svg>
  <div class="bar">
    <button id="toggle" aria-label="Play or pause">
      <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path id="icon" d="M4 2l10 6-10 6z"/></svg>
    </button>
    <input id="scrub" type="range" min="0" max="1000" value="0" aria-label="Timeline">
    <span class="time" id="clock">0.00s</span>
  </div>
  <div class="caption">Generated with svg-path-editor morph timeline</div>
</div>
<script>
(function () {
  "use strict";
  var DATA = ${payload};
  var EASING_LABELS = ${easingTable};

  function pt(x, y) { return { x: x, y: y }; }
  function d2(a, b) { var dx = a.x - b.x, dy = a.y - b.y; return dx * dx + dy * dy; }
  function lerp(a, b, t) { return pt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t); }
  function eq(a, b) { return Math.abs(a - b) < 1e-9; }

  function arcToCubics(x1, y1, rxIn, ryIn, rot, large, sweep, x2, y2) {
    var rx = Math.abs(rxIn), ry = Math.abs(ryIn);
    if (eq(x1, x2) && eq(y1, y2)) return [];
    if (eq(rx, 0) || eq(ry, 0)) return [{ c1: pt(x1, y1), c2: pt(x2, y2), p: pt(x2, y2) }];
    var phi = rot * Math.PI / 180, cp = Math.cos(phi), sp = Math.sin(phi);
    var dx2 = (x1 - x2) / 2, dy2 = (y1 - y2) / 2;
    var x1p = cp * dx2 + sp * dy2, y1p = -sp * dx2 + cp * dy2;
    var lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
    if (lam > 1) { var s = Math.sqrt(lam); rx *= s; ry *= s; }
    var rx2 = rx * rx, ry2 = ry * ry, xp2 = x1p * x1p, yp2 = y1p * y1p;
    var num = rx2 * ry2 - rx2 * yp2 - ry2 * xp2;
    var den = rx2 * yp2 + ry2 * xp2;
    var sign = large !== sweep ? 1 : -1;
    var coef = den === 0 ? 0 : sign * Math.sqrt(Math.max(0, num / den));
    var cxp = coef * rx * y1p / ry, cyp = -coef * ry * x1p / rx;
    var cx = cp * cxp - sp * cyp + (x1 + x2) / 2;
    var cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    var ux = (x1p - cxp) / rx, uy = (y1p - cyp) / ry;
    var vx = (-x1p - cxp) / rx, vy = (-y1p - cyp) / ry;
    var t1 = Math.atan2(uy, ux);
    var dt = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
    if (!sweep && dt > 0) dt -= Math.PI * 2; else if (sweep && dt < 0) dt += Math.PI * 2;
    var n = Math.max(1, Math.ceil(Math.abs(dt) / (Math.PI / 2)));
    var delta = dt / n, alpha = 4 / 3 * Math.tan(delta / 4);
    function at(t) { return pt(cx + rx * cp * Math.cos(t) - ry * sp * Math.sin(t), cy + rx * sp * Math.cos(t) + ry * cp * Math.sin(t)); }
    function dv(t) { return pt(-rx * cp * Math.sin(t) - ry * sp * Math.cos(t), -rx * sp * Math.sin(t) + ry * cp * Math.cos(t)); }
    var out = [], t0 = t1;
    for (var i = 0; i < n; i++) {
      var t2 = t0 + delta, p0 = at(t0), p1 = at(t2), d0 = dv(t0), d1v = dv(t2);
      out.push({
        c1: pt(p0.x + alpha * d0.x, p0.y + alpha * d0.y),
        c2: pt(p1.x - alpha * d1v.x, p1.y - alpha * d1v.y),
        p: i === n - 1 ? pt(x2, y2) : p1
      });
      t0 = t2;
    }
    return out;
  }

  var CMD = /[MLHVZCSQTAmlhvzcsqta]/;
  var NUM = /^[+-]?((\\d*\\.\\d+)|(\\d+\\.)|(\\d+))([eE][+-]?\\d+)?/;

  function tokenize(d) {
    var tokens = [], i = 0, len = d.length;
    while (i < len) {
      while (i < len && /\\s|,/.test(d[i])) i++;
      if (i >= len) break;
      var c = d[i];
      if (!CMD.test(c)) throw new Error('bad path');
      i++;
      var args = [];
      while (i < len) {
        while (i < len && /\\s|,/.test(d[i])) i++;
        if (i >= len || CMD.test(d[i])) break;
        var m = d.slice(i).match(NUM);
        if (!m) break;
        args.push(parseFloat(m[0]));
        i += m[0].length;
      }
      tokens.push({ c: c, a: args });
    }
    return tokens;
  }

  function parseSubPaths(d) {
    var tokens = tokenize((d || '').trim());
    var subs = [], cur = null, cx = 0, cy = 0, sx = 0, sy = 0, pc = null, pq = null;
    function ensure() {
      if (!cur) { cur = { start: pt(cx, cy), segments: [], closed: false }; subs.push(cur); }
      return cur;
    }
    for (var k = 0; k < tokens.length; k++) {
      var t = tokens[k], c = t.c, rel = c !== c.toUpperCase(), T = c.toUpperCase(), v = t.a;
      var ox = rel ? cx : 0, oy = rel ? cy : 0, nc = null, nq = null;
      if (T === 'M') {
        cx = ox + v[0]; cy = oy + v[1]; sx = cx; sy = cy;
        cur = { start: pt(cx, cy), segments: [], closed: false }; subs.push(cur);
      } else if (T === 'L' || T === 'H' || T === 'V') {
        var tx = T === 'L' ? ox + v[0] : T === 'H' ? ox + v[0] : cx;
        var ty = T === 'L' ? oy + v[1] : T === 'V' ? oy + v[0] : cy;
        ensure().segments.push({ c1: pt(cx, cy), c2: pt(tx, ty), p: pt(tx, ty) });
        cx = tx; cy = ty;
      } else if (T === 'C') {
        var c1 = pt(ox + v[0], oy + v[1]), c2 = pt(ox + v[2], oy + v[3]), p = pt(ox + v[4], oy + v[5]);
        ensure().segments.push({ c1: c1, c2: c2, p: p }); nc = c2; cx = p.x; cy = p.y;
      } else if (T === 'S') {
        var c1s = pc ? pt(2 * cx - pc.x, 2 * cy - pc.y) : pt(cx, cy);
        var c2s = pt(ox + v[0], oy + v[1]), ps = pt(ox + v[2], oy + v[3]);
        ensure().segments.push({ c1: c1s, c2: c2s, p: ps }); nc = c2s; cx = ps.x; cy = ps.y;
      } else if (T === 'Q' || T === 'T') {
        var q = T === 'Q' ? pt(ox + v[0], oy + v[1]) : (pq ? pt(2 * cx - pq.x, 2 * cy - pq.y) : pt(cx, cy));
        var pq2 = T === 'Q' ? pt(ox + v[2], oy + v[3]) : pt(ox + v[0], oy + v[1]);
        ensure().segments.push({
          c1: pt(cx + 2 / 3 * (q.x - cx), cy + 2 / 3 * (q.y - cy)),
          c2: pt(pq2.x + 2 / 3 * (q.x - pq2.x), pq2.y + 2 / 3 * (q.y - pq2.y)),
          p: pq2
        });
        nq = q; cx = pq2.x; cy = pq2.y;
      } else if (T === 'A') {
        var pa = pt(ox + v[5], oy + v[6]);
        var cub = arcToCubics(cx, cy, v[0], v[1], v[2], v[3] !== 0, v[4] !== 0, pa.x, pa.y);
        for (var q2 = 0; q2 < cub.length; q2++) ensure().segments.push(cub[q2]);
        cx = pa.x; cy = pa.y;
      } else if (T === 'Z') {
        var sub = ensure();
        if (d2(pt(cx, cy), pt(sx, sy)) > 1e-12) sub.segments.push({ c1: pt(cx, cy), c2: pt(sx, sy), p: pt(sx, sy) });
        sub.closed = true; cx = sx; cy = sy; cur = null;
      }
      pc = nc; pq = nq;
    }
    return subs.filter(function (s) { return s.segments.length || s.start; });
  }

  function flat(s) { var out = [s.start]; for (var i = 0; i < s.segments.length; i++) { out.push(s.segments[i].c1, s.segments[i].c2, s.segments[i].p); } return out; }
  function cost(a, b) { var pa = flat(a), pb = flat(b), sum = 0; for (var i = 0; i < pa.length; i++) { sum += d2(pa[i], pb[i]); if (sum > 1e12) return sum; } return sum; }
  function reverse(s) {
    var pts = [s.start];
    for (var i = 0; i < s.segments.length; i++) pts.push(s.segments[i].p);
    var segs = [];
    for (var j = s.segments.length - 1; j >= 0; j--) segs.push({ c1: s.segments[j].c2, c2: s.segments[j].c1, p: pts[j] });
    return { start: pts[pts.length - 1], segments: segs, closed: s.closed };
  }
  function rotate(s, off) {
    var n = s.segments.length; if (!n || off % n === 0) return s;
    var k = ((off % n) + n) % n;
    var segs = s.segments.slice(k).concat(s.segments.slice(0, k));
    var start = k === 0 ? s.start : s.segments[k - 1].p;
    return { start: pt(start.x, start.y), segments: segs, closed: s.closed };
  }
  function align(sub, ref) {
    var n = sub.segments.length, best = sub, bestCost = Infinity;
    function consider(c) { var v = cost(c, ref); if (v < bestCost) { bestCost = v; best = c; } }
    consider(sub); consider(reverse(sub));
    if (sub.closed && n > 0) {
      var stride = n > 256 ? Math.max(1, Math.floor(n / 32)) : 1;
      var lim = n > 256 ? 32 : n;
      for (var i = stride; i < lim; i += stride) { consider(rotate(sub, i)); consider(rotate(reverse(sub), i)); }
    }
    return best;
  }
  function pad(s, count) {
    if (s.segments.length >= count) return s;
    var last = s.segments.length ? s.segments[s.segments.length - 1].p : s.start;
    var segs = s.segments.slice();
    while (segs.length < count) segs.push({ c1: pt(last.x, last.y), c2: pt(last.x, last.y), p: pt(last.x, last.y) });
    return { start: pt(s.start.x, s.start.y), segments: segs, closed: s.closed };
  }
  function collapse(anchor) { return { start: pt(anchor.x, anchor.y), segments: [{ c1: pt(anchor.x, anchor.y), c2: pt(anchor.x, anchor.y), p: pt(anchor.x, anchor.y) }], closed: false }; }
  function endOf(s) { return s.segments.length ? s.segments[s.segments.length - 1].p : s.start; }

  function prepare(fromD, toD) {
    var f = parseSubPaths(fromD), t = parseSubPaths(toD);
    var fa = f.length ? endOf(f[f.length - 1]) : pt(0, 0);
    var ta = t.length ? endOf(t[t.length - 1]) : pt(0, 0);
    while (f.length < t.length) f.push(collapse(t[f.length].start));
    while (t.length < f.length) t.push(collapse(f[t.length].start));
    for (var i = 0; i < f.length; i++) {
      var c = Math.max(f[i].segments.length, t[i].segments.length, 1);
      f[i] = pad(f[i], c); t[i] = pad(t[i], c);
    }
    for (var j = 0; j < t.length; j++) t[j] = align(t[j], f[j]);
    if (!f.length && !t.length) return { from: [], to: [] };
    if (!f.length) return { from: t.map(function () { return collapse(fa); }), to: t };
    if (!t.length) return { from: f, to: f.map(function () { return collapse(ta); }) };
    return { from: f, to: t };
  }

  function round3(v) { return Math.round(v * 1000) / 1000; }
  function toPathData(subs) {
    var parts = [];
    for (var i = 0; i < subs.length; i++) {
      var s = subs[i];
      if (!s.segments.length) continue;
      parts.push('M ' + round3(s.start.x) + ' ' + round3(s.start.y));
      for (var j = 0; j < s.segments.length; j++) {
        var g = s.segments[j];
        parts.push('C ' + round3(g.c1.x) + ' ' + round3(g.c1.y) + ' ' + round3(g.c2.x) + ' ' + round3(g.c2.y) + ' ' + round3(g.p.x) + ' ' + round3(g.p.y));
      }
      if (s.closed) parts.push('Z');
    }
    return parts.join(' ');
  }

  function morphAt(pair, t) {
    var out = [];
    for (var i = 0; i < pair.from.length; i++) {
      var a = pair.from[i], b = pair.to[i] || a, segs = [];
      for (var j = 0; j < a.segments.length; j++) {
        var sa = a.segments[j], sb = b.segments[j] || sa;
        segs.push({ c1: lerp(sa.c1, sb.c1, t), c2: lerp(sa.c2, sb.c2, t), p: lerp(sa.p, sb.p, t) });
      }
      out.push({ start: lerp(a.start, b.start, t), segments: segs, closed: t < 0.5 ? a.closed : b.closed });
    }
    return out;
  }

  var EAS = {
    linear: function (t) { return t; },
    easeInQuad: function (t) { return t * t; },
    easeOutQuad: function (t) { return t * (2 - t); },
    easeInOutQuad: function (t) { return t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t; },
    easeInCubic: function (t) { return t * t * t; },
    easeOutCubic: function (t) { return 1 - Math.pow(1 - t, 3); },
    easeInOutCubic: function (t) { return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2; },
    easeOutBack: function (t) { var c1 = 1.70158, c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
    easeInOutSine: function (t) { return -(Math.cos(Math.PI * t) - 1) / 2; }
  };
  function ease(name, t) { t = t < 0 ? 0 : t > 1 ? 1 : t; var f = EAS[name] || EAS.linear; return f(t); }

  var kfs = DATA.keyframes;
  var segs = [];
  for (var i = 1; i < kfs.length; i++) {
    segs.push({ pair: prepare(kfs[i - 1].path, kfs[i].path), easing: kfs[i].easing, duration: Math.max(1, kfs[i].duration) });
  }
  var total = segs.reduce(function (a, s) { return a + s.duration; }, 0);

  var shape = document.getElementById('shape');
  var toggle = document.getElementById('toggle');
  var icon = document.getElementById('icon');
  var scrub = document.getElementById('scrub');
  var clock = document.getElementById('clock');

  var playing = false, playhead = 0, raf = null, last = 0, scrubbing = false;

  function render(time) {
    var rem = time, idx = 0;
    for (var i = 0; i < segs.length; i++) {
      if (rem < segs[i].duration || i === segs.length - 1) { idx = i; break; }
      rem -= segs[i].duration;
    }
    var s = segs[idx], local = rem / s.duration;
    shape.setAttribute('d', toPathData(morphAt(s.pair, ease(s.easing, Math.min(1, local)))));
    clock.textContent = (time / 1000).toFixed(2) + 's';
    if (!scrubbing) scrub.value = String(Math.round((time / total) * 1000));
  }

  function frame(ts) {
    if (!playing) return;
    if (!last) last = ts;
    var dt = Math.min(ts - last, 100);
    last = ts;
    playhead += dt;
    if (playhead >= total) {
      if (DATA.loop) playhead = playhead % total;
      else { playhead = total; render(total); pause(); return; }
    }
    render(playhead);
    raf = requestAnimationFrame(frame);
  }

  function play() {
    if (playing) return;
    if (playhead >= total) playhead = 0;
    playing = true; last = 0;
    icon.setAttribute('d', 'M3 2h4v12H3zM9 2h4v12H9z');
    raf = requestAnimationFrame(frame);
  }
  function pause() {
    playing = false;
    if (raf) cancelAnimationFrame(raf);
    raf = null;
    icon.setAttribute('d', 'M4 2l10 6-10 6z');
  }

  toggle.addEventListener('click', function () { playing ? pause() : play(); });
  scrub.addEventListener('input', function () {
    scrubbing = true;
    playhead = (Number(scrub.value) / 1000) * total;
    render(playhead);
    scrubbing = false;
  });
  document.addEventListener('keydown', function (e) {
    if (e.code === 'Space') { e.preventDefault(); playing ? pause() : play(); }
  });

  render(0);
  if (DATA.loop) play();
})();
</script>
</body>
</html>
`;
}

export function downloadText(filename: string, content: string, mime = 'text/plain'): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export const resolveTimelineForExport = resolveTimeline;
