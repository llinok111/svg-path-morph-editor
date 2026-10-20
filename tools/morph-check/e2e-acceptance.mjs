import { chromium } from 'playwright-core';
import { pathToFileURL } from 'url';
import crypto from 'crypto';
import fs from 'fs';
const OUT_BASE = process.env.OUT_DIR || './tools/morph-check/out';
const DL = OUT_BASE;
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const OUT = process.env.OUT_DIR || './tools/morph-check/out';
const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const ctx = await b.newContext({ viewport:{width:1440,height:900}, deviceScaleFactor:2, acceptDownloads:true });
const p = await ctx.newPage();
const errs=[]; p.on('pageerror',e=>errs.push(e.message)); p.on('console',m=>{if(m.type()==='error')errs.push(m.text());});
await p.goto(APP_URL, { waitUntil:'domcontentloaded' });
await p.evaluate(()=>document.fonts.ready);
await p.waitForTimeout(1400);

const shapes=['M 6 2.5 A 4.5 4.5 0 1 1 5.9 2.5 Z','M 4 2 L 11 2 L 11 13 L 4 13 Z','M 7.5 1.5 L 9.2 5.6 L 13.5 5.9 L 10.2 8.7 L 11.2 13 L 7.5 10.6 L 3.8 13 L 4.8 8.7 L 1.5 5.9 L 5.8 5.6 Z'];
const ta=p.locator('textarea').first();
await ta.fill(shapes[0]); await p.waitForTimeout(400);
await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(250);
for(const s of shapes.slice(1)){ await ta.fill(s); await p.waitForTimeout(450); await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(250); }
await p.waitForTimeout(300);
await p.screenshot({ path:`${OUT}/final-01-timeline.png` });

// mid frame
await p.evaluate(()=>{const s=document.querySelector('.scrub'); s.value=String(Math.round(Number(s.max)*0.33)); s.dispatchEvent(new Event('input'));});
await p.waitForTimeout(500);
await p.screenshot({ path:`${OUT}/final-02-midframe.png` });

// play, capture fps
await p.locator('.play-button').click();
await p.waitForTimeout(1600);
const fps = await p.evaluate(()=>document.querySelector('.fps')?.textContent.trim());
await p.screenshot({ path:`${OUT}/final-03-playing.png` });
await p.locator('.play-button').click();
await p.waitForTimeout(300);

// export both
for (const [aria,name] of [['Export animated SVG','morph-animation.svg'],['Export HTML player','morph-animation.html']]) {
  const dl=p.waitForEvent('download');
  await p.locator(`button[aria-label="${aria}"]`).click();
  const d=await dl; await d.saveAs(`${DL}/${name}`);
}
const state = await p.evaluate(()=>({chips:[...document.querySelectorAll('.kf-chip')].map(c=>c.innerText.replace(/\n/g,'/')), sub:document.querySelector('.morph-title .subtitle')?.textContent.trim()}));
await b.close();

// verify exports offline
const b2 = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const c2 = await b2.newContext({ offline:true, viewport:{width:800,height:800}, deviceScaleFactor:2 });
const p2 = await c2.newPage();
const e2=[]; p2.on('pageerror',x=>e2.push(x.message));
await p2.goto(pathToFileURL(`${DL}/morph-animation.html`).href);
await p2.waitForTimeout(900);
await p2.screenshot({ path:`${OUT}/final-04-export-html.png` });
await b2.close();

const b3 = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const p3 = await b3.newPage({ viewport:{width:800,height:800}, deviceScaleFactor:2 });
await p3.goto(pathToFileURL(`${DL}/morph-animation.svg`).href);
const hashes=[];
for(let i=0;i<4;i++){ const buf=await p3.locator('svg').screenshot(); hashes.push(crypto.createHash('sha1').update(buf).digest('hex').slice(0,8)); await p3.waitForTimeout(230); }
await p3.screenshot({ path:`${OUT}/final-05-export-svg.png` });
await b3.close();

const svg=fs.readFileSync(`${DL}/morph-animation.svg`,'utf8');
console.log(JSON.stringify({state, fps, errs, e2, svgUniqueFrames:new Set(hashes).size, svgBytes:svg.length,
  svgDims: svg.match(/width="(\d+)" height="(\d+)"/)?.slice(1), sw: svg.match(/stroke-width="([\d.]+)"/)?.[1]},null,2));
