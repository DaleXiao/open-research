// F2 fix E2E: topbar「papers/库」按钮 — 打开论文后能切换。
// 场景：
//  A. 导入 paper A → topbar papers 钮可见 → 点击 → 回到最近列表（current 清空、列表出现）。
//  B. 从列表点 paper B → 切换成功（标题变 B）。
//  C. 切换不依赖 localStorage（库按钮随时可用，含进站自动恢复后）。
//  D. 中英切换按钮文案；375px 不溢出。
// 跑法：npm run build && (serve dist :4399) && node e2e/papers-button.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const PAPERS = [
  { id: '1706.03762', title: 'Attention Is All You Need', source_type:'arxiv', arxiv_id:'1706.03762', block_count:120, created_at:1781400000000 },
  { id: '2310.06825', title: 'Mistral 7B', source_type:'arxiv', arxiv_id:'2310.06825', block_count:80, created_at:1781300000000 },
];
const mkBlock = (id) => ({ id, type:'para', sec:'s', order:0, level:0, text_en:'hi', text_zh:'嗨', latex:null, img_url:null, caption:null, anchor:`sec-${id}`, translate:true, zh_status:'done' });
const viewFor = (id) => { const p = PAPERS.find(x=>x.id===id)||{id,title:id,arxiv_id:id}; return { paper_id:id, title:p.title, arxiv_id:p.arxiv_id||id, source_url:'https://arxiv.org/abs/'+id, toc:[], blocks:[mkBlock('b1')], stats:{total:1,translatable:1,translated:1} }; };

function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path=url.pathname; const method=req.method();
    const j = (o,s=200)=>route.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
    if (path==='/api/papers' && method==='GET') return j({ papers: PAPERS });
    if (path==='/api/import' && method==='POST') { const b=JSON.parse(req.postData()||'{}'); const id=b.url||b.id; const v=viewFor(id); return j({ paper_id:id, cached:false, title:v.title, arxiv_id:v.arxiv_id, block_count:1 }); }
    const m = path.match(/^\/api\/paper\/([^/]+)$/);
    if (m && method==='GET') return j(viewFor(decodeURIComponent(m[1])));
    if (/\/api\/paper\/[^/]+\/qa$/.test(path)) return j({ history: [] });
    if (/\/api\/paper\/[^/]+\/annotations$/.test(path)) return j({ paper_id:'x', annotations: [] });
    if (/\/api\/paper\/[^/]+\/mindmap$/.test(path)) return j({ markmap_md:'# x', model:'q', lang:'zh', cached:false });
    if (/\/api\/paper\/[^/]+\/translate$/.test(path)) return j({ translated: [] });
    return j({ error:'nf' }, 404);
  });
}

let fail = 0;
const check = (n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };
async function newPage(viewport) {
  const ctx = await br.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.addInitScript(()=>{ try{ localStorage.clear(); }catch{} });
  await installRoutes(pg);
  pg.on('pageerror', e=>console.log('PAGEERR', e.message));
  return { ctx, pg };
}

// ── A + B + C ──
{
  const { ctx, pg } = await newPage({width:1280,height:900});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  // 导入 paper A
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '1706.03762');
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  console.log('=== A: 打开论文后 papers 钮调出列表 ===');
  check('papers 按钮可见', await pg.evaluate(()=>!!document.querySelector('#papers-open')));
  const titleA = await pg.evaluate(()=>document.querySelector('#paper-title')?.textContent);
  check('当前是 paper A', titleA==='Attention Is All You Need', titleA);
  // 点 papers 钮 → 回最近列表
  await pg.click('#papers-open');
  await pg.waitForSelector('.recent-list', { timeout: 4000 });
  check('点击后出现最近列表', !!(await pg.$('.recent-list')));
  const rows = await pg.$$eval('.recent-row .recent-name', els=>els.map(e=>e.textContent));
  check('列表含两篇', rows.length===2, rows);
  const titleCleared = await pg.evaluate(()=>document.querySelector('#paper-title')?.textContent);
  check('标题重置为 no paper', /no paper|未载入/.test(titleCleared||''), titleCleared);

  console.log('=== B: 从列表点 paper B 切换 ===');
  await pg.click('.recent-row:nth-child(1) , .recent-item:nth-child(2) .recent-row');
  // 点第二篇（Mistral）；用更稳的方式：按文本点
  await pg.evaluate(()=>{ const rows=[...document.querySelectorAll('.recent-row')]; const m=rows.find(r=>/Mistral/.test(r.textContent)); m && m.click(); });
  await pg.waitForSelector('[data-block="b1"]', { timeout: 6000 });
  const titleB = await pg.evaluate(()=>document.querySelector('#paper-title')?.textContent);
  check('切换到 paper B (Mistral)', titleB==='Mistral 7B', titleB);

  console.log('=== C: 再次点 papers 仍可调出（不依赖 localStorage）===');
  await pg.click('#papers-open');
  await pg.waitForSelector('.recent-list', { timeout: 4000 });
  check('二次调出列表 OK', !!(await pg.$('.recent-list')));

  console.log('=== D: 中英切换按钮文案 ===');
  await pg.click('#uilang-switch button[data-uilang="en"]');
  await pg.waitForTimeout(200);
  const label = await pg.evaluate(()=>document.querySelector('#papers-open span[data-i18n]')?.textContent);
  check('en 文案 papers', /papers/i.test(label||''), label);
  await ctx.close();
}

// ── E: 375px 不溢出 ──
{
  const { ctx, pg } = await newPage({width:375,height:800});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '1706.03762');
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  console.log('=== E: 375px papers 钮可用不溢出 ===');
  check('papers 钮可见', await pg.evaluate(()=>!!document.querySelector('#papers-open')));
  await pg.click('#papers-open');
  await pg.waitForSelector('.recent-list', { timeout: 4000 });
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  await ctx.close();
}

console.log(fail ? `\nE2E F2-fix: ${fail} CHECK(S) FAILED ✗` : '\nE2E F2-fix: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
