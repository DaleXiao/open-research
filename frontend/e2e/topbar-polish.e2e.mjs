// F6-fix E2E: topbar 收尾 — 控件等高 + 去 ui: 标签 + 靠左加长。
// 场景：
//  A. 顶栏控件等高（.seg/.theme-btn/.icon-btn/#import-btn/.import input 高度一致 ±2px）。
//  B. 去 ui: 标签：uilang-switch 内无 "ui:" 文本，只剩 中/EN。
//  C. 布局：topbar-controls + import 整组靠左，功能钮组（papers...）靠右；import 输入框明显更长。
//  D. 图标语义/防闪烁不回退（night→sun）；375px 不溢出。
// 跑法：npm run build && (serve dist :4399) && node e2e/topbar-polish.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });
function installRoutes(pg){ return pg.route('**/api/**', r=>{const u=new URL(r.request().url());const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)});if(u.pathname==='/api/papers')return j({papers:[]});return j({error:'nf'},404);}); }
let fail=0; const check=(n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };
async function newPage(vp, theme){ const ctx=await br.newContext({viewport:vp}); const pg=await ctx.newPage(); await pg.addInitScript((t)=>{try{localStorage.clear();if(t)localStorage.setItem('research.theme',t)}catch{}},theme); await installRoutes(pg); pg.on('pageerror',e=>console.log('PAGEERR',e.message)); return {ctx,pg}; }

{
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#theme-btn');
  await pg.waitForSelector('#uilang-switch button[data-uilang="zh"]');

  console.log('=== A: 控件等高 ===');
  const heights = await pg.evaluate(()=>{
    const sels = ['#uilang-switch','#theme-btn','#papers-open','#import-btn','#paper-input'];
    return sels.map(s=>{ const e=document.querySelector(s); return e ? Math.round(e.getBoundingClientRect().height) : -1; });
  });
  const [h0,...rest] = heights;
  const maxDiff = Math.max(...heights) - Math.min(...heights);
  check('5 控件高度一致(±2px)', maxDiff <= 2, heights);

  console.log('=== B: 去 ui: 标签 ===');
  const uiText = await pg.evaluate(()=>document.querySelector('#uilang-switch')?.textContent || '');
  check('uilang 无 ui: 前缀', !uiText.includes('ui:'), JSON.stringify(uiText));
  check('uilang 只剩 中/EN', /中/.test(uiText) && /EN/.test(uiText), JSON.stringify(uiText));
  const hasPrefix = await pg.evaluate(()=>!!document.querySelector('#uilang-switch .seg-prefix'));
  check('uilang 无 .seg-prefix 节点', !hasPrefix);

  console.log('=== C: 布局靠左 + import 加长 + 功能钮靠右 ===');
  const geo = await pg.evaluate(()=>{
    const controls=document.querySelector('.topbar-controls').getBoundingClientRect();
    const imp=document.querySelector('.import').getBoundingClientRect();
    const input=document.querySelector('#paper-input').getBoundingClientRect();
    const papers=document.querySelector('#papers-open').getBoundingClientRect();
    const notes=document.querySelector('#notes-open').getBoundingClientRect();
    return { controlsLeft:controls.left, impLeft:imp.left, impW:imp.width, inputW:input.width, papersLeft:papers.left, notesRight:notes.right, vw:window.innerWidth };
  });
  check('controls 在 import 左侧', geo.controlsLeft < geo.impLeft, geo);
  check('import 整组靠左(controls 在视口左半)', geo.controlsLeft < geo.vw*0.4, geo);
  check('功能钮组在 import 右侧', geo.papersLeft > geo.impLeft, geo);
  check('import 输入框加长(import 组 >340px)', geo.impW > 340, geo.impW);

  console.log('=== D: 图标语义不回退 ===');
  const sunV = await pg.evaluate(()=>getComputedStyle(document.querySelector('#theme-btn .icon-sun')).display);
  check('night 仍显太阳(语义不回退)', sunV==='block', sunV);
  await ctx.close();
}

// 375px
{
  const { ctx, pg } = await newPage({width:375,height:800}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#theme-btn');
  console.log('=== E: 375px 不溢出 ===');
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  await ctx.close();
}

console.log(fail ? `\nE2E F6-fix: ${fail} CHECK(S) FAILED ✗` : '\nE2E F6-fix: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
