import { chromium } from 'playwright-core';
const APP_URL = process.env.APP_URL || 'http://127.0.0.1:4321/';
const b = await chromium.launch({ executablePath: process.env.BROWSER_PATH || undefined, headless:true });
const p = await b.newPage({ viewport:{width:1440,height:900} });
await p.goto(APP_URL, { waitUntil:'domcontentloaded' });
await p.evaluate(()=>document.fonts.ready);
await p.waitForTimeout(1000);

// Build a heavy timeline: 6 keyframes with a 120-segment path
const heavy = (n, r) => {
  const pts=[];
  for(let i=0;i<n;i++){ const a=(i/n)*Math.PI*2; pts.push(`${(8+r*Math.cos(a)).toFixed(2)} ${(7+r*Math.sin(a)).toFixed(2)}`); }
  return 'M ' + pts.join(' L ') + ' Z';
};
const ta=p.locator('textarea').first();
const shapes=[heavy(120,5), heavy(120,4.2), heavy(120,5.5), heavy(120,3.6), heavy(120,4.8), heavy(120,4)];
await ta.fill(shapes[0]); await p.waitForTimeout(400);
await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(200);
for(const s of shapes.slice(1)){ await ta.fill(s); await p.waitForTimeout(400); await p.locator('app-morph-timeline button[aria-label="Add keyframe"]').click(); await p.waitForTimeout(200); }

const chips = await p.evaluate(()=>[...document.querySelectorAll('.kf-chip')].length);

// Instrument rAF frame durations during playback
await p.evaluate(()=>{ window.__frames=[]; const orig=window.requestAnimationFrame; let last=0;
  window.requestAnimationFrame = (cb)=>orig((t)=>{ if(last) window.__frames.push(t-last); last=t; cb(t); }); });

await p.locator('.play-button').click();
await p.waitForTimeout(3000);
const stats = await p.evaluate(()=>{
  const f=window.__frames.slice(5);
  f.sort((a,b)=>a-b);
  const sum=f.reduce((a,b)=>a+b,0);
  return { n:f.length, avgMs:+(sum/f.length).toFixed(2), p50:+(f[Math.floor(f.length*0.5)]).toFixed(2),
           p95:+(f[Math.floor(f.length*0.95)]).toFixed(2), max:+(f[f.length-1]).toFixed(2),
           fpsShown: document.querySelector('.fps')?.textContent.trim() };
});
await p.locator('.play-button').click();

// Long task observer
const lt = await p.evaluate(()=>new Promise(res=>{
  const out=[]; const po=new PerformanceObserver(l=>{for(const e of l.getEntries()) out.push(Math.round(e.duration));});
  try{ po.observe({entryTypes:['longtask']}); }catch(e){ res({note:'unsupported'}); return; }
  document.querySelector('.play-button').click();
  setTimeout(()=>{ po.disconnect(); document.querySelector('.play-button').click(); res({longTasks:out, count:out.length, max: out.length?Math.max(...out):0}); }, 3000);
}));

console.log(JSON.stringify({chips, stats, lt}, null, 2));
await b.close();
