// F6 E2E: 语言/昼夜切换移至 import 左侧 + 主题图标语义反转。
// 场景：
//  A. topbar-controls（uilang + theme）在 import 左侧（DOM 顺序 + 几何 x 坐标）。
//  B. 主题图标语义反转：night→显太阳(icon-sun)、day→显月亮(icon-moon)；点击切换图标随之变。
//  C. 主题钮无文字标签（.theme-label 不存在或空），纯 SVG。
//  D. aria-label 指目标态（night→切到日间 / day→切到夜间），i18n 跟随。
//  E. 375px topbar 不溢出。
// 跑法：npm run build && (serve dist :4399) && node e2e/topbar-toggles.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

function installRoutes(pg) {
  return pg.route('**/api/**', r=>{ const u=new URL(r.request().url()); const j=o=>r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(o)}); if(u.pathname==='/api/papers')return j({papers:[]}); return j({error:'nf'},404); });
}
let fail = 0;
const check = (n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };
async function newPage(viewport, theme) {
  const ctx = await br.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.addInitScript((th)=>{ try{ localStorage.clear(); if(th) localStorage.setItem('research.theme', th); }catch{} }, theme);
  await installRoutes(pg);
  pg.on('pageerror', e=>console.log('PAGEERR', e.message));
  return { ctx, pg };
}
const visible = (pg, sel) => pg.evaluate(s=>{ const e=document.querySelector(s); if(!e) return false; const cs=getComputedStyle(e); return cs.display!=='none' && cs.visibility!=='hidden'; }, sel);

// ── A + C: 布局 + 无文字标签（默认 night）──
{
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#theme-btn');
  console.log('=== A: controls 在 import 左侧 ===');
  check('topbar-controls 存在', !!(await pg.$('.topbar-controls')));
  check('uilang + theme 在 controls 内', !!(await pg.$('.topbar-controls #uilang-switch')) && !!(await pg.$('.topbar-controls #theme-btn')));
  const order = await pg.evaluate(()=>{ const c=document.querySelector('.topbar-controls'); const im=document.querySelector('.import'); if(!c||!im) return 'missing'; return c.getBoundingClientRect().left < im.getBoundingClientRect().left ? 'left' : 'right'; });
  check('controls 几何在 import 左侧', order==='left', order);
  console.log('=== C: 主题钮无文字标签纯 SVG ===');
  const labelText = await pg.evaluate(()=>{ const l=document.querySelector('#theme-label'); return l ? (l.textContent||'').trim() : 'NO_ELEMENT'; });
  check('无 theme-label 文字', labelText==='NO_ELEMENT' || labelText==='', labelText);
  check('主题钮含 SVG icon', !!(await pg.$('#theme-btn svg.icon')));

  console.log('=== B: night 显太阳 ===');
  check('night → icon-sun 可见', await visible(pg,'#theme-btn .icon-sun'), 'sun');
  check('night → icon-moon 隐藏', !(await visible(pg,'#theme-btn .icon-moon')), 'moon');

  console.log('=== D: aria 指目标态 ===');
  const ariaNight = await pg.evaluate(()=>document.querySelector('#theme-btn').getAttribute('aria-label'));
  check('night aria=切到日间', /日间|day/i.test(ariaNight), ariaNight);
  // 点击切到 day → 图标变月亮
  await pg.click('#theme-btn');
  await pg.waitForTimeout(150);
  check('点击后 data-theme=day', (await pg.evaluate(()=>document.documentElement.getAttribute('data-theme')))==='day');
  check('day → icon-moon 可见', await visible(pg,'#theme-btn .icon-moon'), 'moon');
  check('day → icon-sun 隐藏', !(await visible(pg,'#theme-btn .icon-sun')), 'sun');
  const ariaDay = await pg.evaluate(()=>document.querySelector('#theme-btn').getAttribute('aria-label'));
  check('day aria=切到夜间', /夜间|night/i.test(ariaDay), ariaDay);
  await ctx.close();
}

// ── E: 375px 不溢出 ──
{
  const { ctx, pg } = await newPage({width:375,height:800}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#theme-btn');
  console.log('=== E: 375px topbar 不溢出 ===');
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  check('375px controls 可见', await visible(pg,'.topbar-controls'));
  await ctx.close();
}

console.log(fail ? `\nE2E F6: ${fail} CHECK(S) FAILED ✗` : '\nE2E F6: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
