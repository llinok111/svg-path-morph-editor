import { chromium } from 'playwright-core';
const URL_LIVE = process.env.LIVE_URL || 'https://llinok111.github.io/svg-path-morph-editor/';
const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless: true });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
const errs = []; p.on('pageerror', e => errs.push(e.message)); p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await p.goto(URL_LIVE, { waitUntil: 'domcontentloaded', timeout: 60000 });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(3000);

const state = await p.evaluate(() => ({
  hasTimeline: !!document.querySelector('app-morph-timeline'),
  hasCanvasPath: !!document.querySelector('.drawings svg path'),
  title: document.title
}));
await p.screenshot({ path: process.env.OUT_DIR ? `${process.env.OUT_DIR}/live.png` : './tools/morph-check/live.png' });
console.log(JSON.stringify({ ...state, errors: errs.slice(0, 5) }, null, 2));
await b.close();
