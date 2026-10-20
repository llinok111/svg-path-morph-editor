import { chromium } from 'playwright-core';
import fs from 'fs';
import { pathToFileURL } from 'url';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const OUT = process.env.OUT_DIR || './tools/morph-check/out';
const DL = process.env.OUT_DIR || new URL('./out/', import.meta.url).pathname.replace(/^\//,'');
fs.mkdirSync(DL,{recursive:true});
const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const ctx = await b.newContext({ viewport:{width:1200,height:760}, acceptDownloads:true });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message));
await p.goto(APP_URL, { waitUntil:'domcontentloaded' });
await p.evaluate(()=>document.fonts.ready);
await p.waitForTimeout(1200);
const shapes=['M 6 2.5 A 4.5 4.5 0 1 1 5.9 2.5 Z','M 4 2 L 11 2 L 11 13 L 4 13 Z','M 7.5 1.5 L 9.2 5.6 L 13.5 5.9 L 10.2 8.7 L 11.2 13 L 7.5 10.6 L 3.8 13 L 4.8 8.7 L 1.5 5.9 L 5.8 5.6 Z'];
const ta=p.locator('textarea').first();
await ta.fill(shapes[0]); await p.waitForTimeout(400);
await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(250);
for(const s of shapes.slice(1)){ await ta.fill(s); await p.waitForTimeout(450); await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(250); }

const dl1 = p.waitForEvent('download');
await p.locator('button[aria-label="Export animated SVG"]').click();
const d1 = await dl1; await d1.saveAs(`${DL}/morph-animation.svg`);
const dl2 = p.waitForEvent('download');
await p.locator('button[aria-label="Export HTML player"]').click();
const d2 = await dl2; await d2.saveAs(`${DL}/morph-animation.html`);
await b.close();

// Verify the exported HTML in a *fresh* browser, offline
const b2 = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const ctx2 = await b2.newContext({ offline:true, viewport:{width:900,height:700} });
const p2 = await ctx2.newPage();
const e2=[]; p2.on('pageerror',x=>e2.push(x.message));
await p2.goto(pathToFileURL(`${DL}/morph-animation.html`).href);
await p2.waitForTimeout(500);
const firstD = await p2.evaluate(()=>document.getElementById('shape').getAttribute('d')?.slice(0,50));
await p2.waitForTimeout(700);
const laterD = await p2.evaluate(()=>document.getElementById('shape').getAttribute('d')?.slice(0,50));
const clock1 = await p2.evaluate(()=>document.getElementById('clock').textContent);
await p2.screenshot({path:`${OUT}/08-exported-html.png`});
// Pause and scrub
await p2.evaluate(()=>document.getElementById('toggle').click());
await p2.evaluate(()=>{const s=document.getElementById('scrub'); s.value='500'; s.dispatchEvent(new Event('input'));});
await p2.waitForTimeout(300);
const scrubD = await p2.evaluate(()=>document.getElementById('shape').getAttribute('d')?.slice(0,50));
await p2.screenshot({path:`${OUT}/09-exported-scrub.png`});
await b2.close();

const svgTxt = fs.readFileSync(`${DL}/morph-animation.svg`,'utf8');
const htmlTxt = fs.readFileSync(`${DL}/morph-animation.html`,'utf8');
console.log(JSON.stringify({
  svgBytes: svgTxt.length, htmlBytes: htmlTxt.length,
  svgHasAnimate: svgTxt.includes('<animate'), svgValues: (svgTxt.match(/values="/)?.[1]?.split(';').length)||0,
  animates: firstD!==laterD, clock1, scrubChanged: scrubD!==laterD,
  errs, e2
},null,2));
