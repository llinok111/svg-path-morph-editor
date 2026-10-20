import { chromium } from 'playwright-core';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const OUT = process.env.OUT_DIR || './tools/morph-check/out';
const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
for (const [w,h,name] of [[1440,900,'desktop'],[1024,768,'tablet'],[768,900,'small'],[390,844,'phone']]) {
  const p = await b.newPage({ viewport:{width:w,height:h}, deviceScaleFactor:1 });
  await p.goto(APP_URL, { waitUntil:'domcontentloaded' });
  await p.evaluate(()=>document.fonts.ready);
  await p.waitForTimeout(1300);
  if (w <= 500) {
    // collapse the left panel like a real phone user would, to reach the canvas
    await p.locator('.left-column-close').click().catch(()=>{});
    await p.waitForTimeout(500);
  }
  await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click();
  await p.locator('textarea').first().fill('M 6 2.5 A 4.5 4.5 0 1 1 5.9 2.5 Z').catch(()=>{});
  await p.waitForTimeout(400);
  await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click();
  await p.waitForTimeout(400);
  const m = await p.evaluate(()=>{
    const d=document.querySelector('app-morph-timeline').getBoundingClientRect();
    const c=document.querySelector('.drawings').getBoundingClientRect();
    const chips=[...document.querySelectorAll('.kf-chip')].map(e=>e.getBoundingClientRect());
    return { dockW:Math.round(d.width), dockH:Math.round(d.height),
             canvas:{w:Math.round(c.width),h:Math.round(c.height)},
             chipOverflow: chips.some(c2=>c2.right > window.innerWidth+1),
             docW: document.documentElement.scrollWidth, vw: window.innerWidth };
  });
  await p.screenshot({ path:`${OUT}/s-${name}.png` });
  console.log(name, JSON.stringify(m));
  await p.close();
}
await b.close();
