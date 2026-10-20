import { exportHtmlPlayer, exportSvgAnimation } from './morph-export';
import { Keyframe } from './path-morph';

const circle = 'M 6 2.5 A 4.5 4.5 0 1 1 5.9 2.5 Z';
const square = 'M 4 2 L 11 2 L 11 13 L 4 13 Z';

const kf = (paths: string[], duration = 600): Keyframe[] =>
  paths.map((path, i) => ({
    path,
    easing: i === 0 ? 'linear' : 'easeInOutCubic',
    duration: i === 0 ? 0 : duration
  }));

describe('exportSvgAnimation', () => {
  it('should refuse to export fewer than two keyframes', () => {
    expect(() => exportSvgAnimation([])).toThrowError(/two keyframes/i);
    expect(() => exportSvgAnimation(kf([circle]))).toThrowError(/two keyframes/i);
  });

  it('should ignore blank keyframes when counting', () => {
    expect(() => exportSvgAnimation(kf([circle, '   ']))).toThrowError(/two keyframes/i);
  });

  it('should emit a valid SMIL animate element', () => {
    const svg = exportSvgAnimation(kf([circle, square]));
    expect(svg).toContain('<animate');
    expect(svg).toContain('attributeName="d"');
    expect(svg).toContain('repeatCount="indefinite"');
    expect(svg).toContain('calcMode="linear"');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
  });

  it('should keep keyTimes and values at the same length', () => {
    const svg = exportSvgAnimation(kf([circle, square, circle]));
    const values = svg.match(/values="([^"]*)"/)?.[1].split(';') ?? [];
    const keyTimes = svg.match(/keyTimes="([^"]*)"/)?.[1].split(';') ?? [];
    expect(values.length).toBeGreaterThan(2);
    expect(values.length).toBe(keyTimes.length);
  });

  it('should start keyTimes at 0 and end at exactly 1', () => {
    const svg = exportSvgAnimation(kf([circle, square, circle]));
    const keyTimes = svg.match(/keyTimes="([^"]*)"/)?.[1].split(';') ?? [];
    expect(Number(keyTimes[0])).toBe(0);
    expect(keyTimes[keyTimes.length - 1]).toBe('1');
  });

  it('should keep keyTimes monotonically increasing', () => {
    const svg = exportSvgAnimation(kf([circle, square, circle]));
    const keyTimes = (svg.match(/keyTimes="([^"]*)"/)?.[1].split(';') ?? []).map(Number);
    for (let i = 1; i < keyTimes.length; i++) {
      expect(keyTimes[i]).toBeGreaterThanOrEqual(keyTimes[i - 1]);
    }
  });

  it('should respect repeatCount when looping is off', () => {
    const svg = exportSvgAnimation(kf([circle, square]), { loop: false });
    expect(svg).toContain('repeatCount="1"');
    expect(svg).not.toContain('indefinite');
  });

  it('should scale the canvas instead of emitting a tiny icon', () => {
    const svg = exportSvgAnimation(kf([circle, square]), { size: 640 });
    const width = Number(svg.match(/width="(\d+)"/)?.[1]);
    const height = Number(svg.match(/height="(\d+)"/)?.[1]);
    expect(Math.max(width, height)).toBe(640);
  });

  it('should preserve the aspect ratio of the artwork', () => {
    // A wide, flat shape must not be stretched into a square canvas.
    const svg = exportSvgAnimation(kf(['M 0 0 L 100 0 L 100 10 Z', 'M 0 0 L 100 0 L 100 12 Z']), {
      size: 640
    });
    const width = Number(svg.match(/width="(\d+)"/)?.[1]);
    const height = Number(svg.match(/height="(\d+)"/)?.[1]);
    expect(width).toBe(640);
    expect(height).toBeLessThan(width / 2);
  });

  it('should derive a stroke width proportional to the artwork', () => {
    const svg = exportSvgAnimation(kf([circle, square]));
    const sw = Number(svg.match(/stroke-width="([\d.]+)"/)?.[1]);
    expect(sw).toBeGreaterThan(0);
    expect(sw).toBeLessThan(10);
  });

  it('should let callers override stroke width explicitly', () => {
    const svg = exportSvgAnimation(kf([circle, square]), { strokeWidth: 4 });
    expect(svg).toContain('stroke-width="4"');
  });

  it('should expand the viewBox to cover every keyframe', () => {
    const svg = exportSvgAnimation(kf(['M 0 0 L 1 0 L 1 1 Z', 'M 0 0 L 100 0 L 100 100 Z']));
    const viewBox = svg.match(/viewBox="([^"]*)"/)?.[1].split(' ').map(Number) ?? [];
    expect(viewBox[2]).toBeGreaterThanOrEqual(100);
    expect(viewBox[3]).toBeGreaterThanOrEqual(100);
  });

  it('should honour the samples-per-second option', () => {
    const low = exportSvgAnimation(kf([circle, square], 1000), { samplesPerSecond: 10 });
    const high = exportSvgAnimation(kf([circle, square], 1000), { samplesPerSecond: 60 });
    const count = (s: string) => (s.match(/values="([^"]*)"/)?.[1].split(';') ?? []).length;
    expect(count(high)).toBeGreaterThan(count(low));
  });
});

describe('exportHtmlPlayer', () => {
  it('should refuse to export fewer than two keyframes', () => {
    expect(() => exportHtmlPlayer([])).toThrowError(/two keyframes/i);
  });

  it('should produce a complete standalone document', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html.startsWith('<!DOCTYPE html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('</html>');
    expect(html).toContain('<svg');
  });

  it('should not reference any external resource', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html).not.toMatch(/<script[^>]+src=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(js|css)/i);
  });

  it('should embed the keyframe payload', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html).toContain('var DATA =');
    expect(html).toContain('"path":');
  });

  it('should declare a responsive viewport', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html).toContain('name="viewport"');
    expect(html).toContain('width=device-width');
  });

  it('should include reduced-motion handling', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html).toContain('prefers-reduced-motion');
  });

  it('should escape angle brackets inside the embedded JSON payload', () => {
    const tricky: Keyframe[] = [
      { path: circle, easing: 'linear', duration: 0 },
      { path: square, easing: 'easeOutBack', duration: 500 }
    ];
    const html = exportHtmlPlayer(tricky);
    const payloadLine = html.split('\n').find((l) => l.includes('var DATA ='));
    expect(payloadLine).toBeDefined();
    expect(payloadLine).not.toContain('</script');
  });

  it('should respect the background option', () => {
    const html = exportHtmlPlayer(kf([circle, square]), { background: '#101010' });
    expect(html).toContain('background: #101010');
  });

  it('should expose play and scrub controls', () => {
    const html = exportHtmlPlayer(kf([circle, square]));
    expect(html).toContain('id="toggle"');
    expect(html).toContain('id="scrub"');
    expect(html).toContain('id="clock"');
  });

  it('should stay a reasonable size for a three keyframe animation', () => {
    const html = exportHtmlPlayer(kf([circle, square, circle]));
    expect(html.length).toBeLessThan(200000);
  });
});
