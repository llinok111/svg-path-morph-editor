import { chromium } from 'playwright-core';
import fs from 'fs';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const OUT = process.env.OUT_DIR || './tools/morph-check/frames';
fs.mkdirSync(OUT, { recursive: true });

const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless: true });
const p = await b.newPage({ viewport: { width: 1000, height: 620 }, deviceScaleFactor: 1 });
await p.goto(APP_URL, { waitUntil: 'domcontentloaded' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(1500);

const shapes = [
  'M 6 2.5 A 4.5 4.5 0 1 1 5.9 2.5 Z',
  'M 4 2 L 11 2 L 11 13 L 4 13 Z',
  'M 7.5 1.5 L 9.2 5.6 L 13.5 5.9 L 10.2 8.7 L 11.2 13 L 7.5 10.6 L 3.8 13 L 4.8 8.7 L 1.5 5.9 L 5.8 5.6 Z'
];
const ta = p.locator('textarea').first();
await ta.fill(shapes[0]);
await p.waitForTimeout(400);
await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click();
await p.waitForTimeout(200);
for (const s of shapes.slice(1)) {
  await ta.fill(s);
  await p.waitForTimeout(400);
  await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click();
  await p.waitForTimeout(200);
}
// Collapse the left panel now that the keyframes are captured.
await p.locator('.left-column-close').click().catch(() => {});
await p.waitForTimeout(1200);

// Zoom to fit AFTER the canvas resized, otherwise the shape keeps the
// viewport it had while the side panel was still open and gets clipped.
await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const fit = btns.find(x => (x.getAttribute('matTooltip') || '') === 'Zoom to Fit');
  if (fit) fit.click();
});
await p.waitForTimeout(900);
await p.evaluate(() => {
  const btns = [...document.querySelectorAll('button')];
  const fit = btns.find(x => (x.getAttribute('matTooltip') || '') === 'Zoom to Fit');
  if (fit) fit.click();
});
await p.waitForTimeout(900);

// Park the cursor over the canvas so no tooltip floats into the capture.
await p.mouse.move(700, 300);
await p.waitForTimeout(500);

const box = await p.locator('.editor-column').boundingBox();
const shotArea = { x: 0, y: 0, width: 1000, height: Math.round(box.height) };

// Play and capture a dense frame sequence
await p.locator('.play-button').click();
const total = 30;
for (let i = 0; i < total; i++) {
  await p.screenshot({ path: `${OUT}/f${String(i).padStart(3, '0')}.png`, clip: shotArea });
  await p.waitForTimeout(55);
}
console.log(JSON.stringify({ frames: total, area: shotArea }));
await b.close();
