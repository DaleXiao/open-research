// F2 E2E: 导入记录持久化 — 进站恢复 + 最近论文列表。
// 三场景：
//  A. 空 localStorage + 无 ?paper → 空工作区渲染「最近论文」列表，点击 = getView 秒开 + 写 last_paper。
//  B. localStorage research:last_paper 已存 → 进站自动 getView 恢复，不显示最近列表。
//  C. URL ?paper= 优先级高于 localStorage → 走 import 路径（即便 last_paper 指向别的）。
// 跑法：npm run build && python3 -m http.server 4399 --directory dist & node e2e/recent.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const PAPERS = [
  { id: '1706.03762', title: 'Attention Is All You Need', source_type: 'arxiv', arxiv_id: '1706.03762', block_count: 120, created_at: 1781400000000 },
  { id: '2310.06825', title: 'Mistral 7B', source_type: 'arxiv', arxiv_id: '2310.06825', block_count: 80, created_at: 1781300000000 },
];
const mkBlock = (id) => ({
  id, type:'para', sec:'s', order:0, level:0,
  text_en:'hello', text_zh:'你好', latex:null, img_url:null, caption:null,
  anchor:`sec-${id}`, translate:true, zh_status:'done',
});
const viewFor = (id) => {
  const p = PAPERS.find(x => x.id === id) || { id, title: id, arxiv_id: id };
  return {
    paper_id: id, title: p.title, arxiv_id: p.arxiv_id || id,
    source_url: 'https://arxiv.org/abs/'+id, toc: [],
    blocks: [mkBlock('b1')], stats: { total:1, translatable:1, translated:1 },
  };
};

let lastListLimit = null;
let importCalled = false;

function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path = url.pathname; const method = req.method();
    const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (path === '/api/papers' && method === 'GET') {
      lastListLimit = url.searchParams.get('limit');
      return j({ papers: PAPERS });
    }
    if (path === '/api/import' && method === 'POST') {
      importCalled = true;
      const body = JSON.parse(req.postData() || '{}');
      const id = body.url || body.id;
      const v = viewFor(id);
      return j({ paper_id: id, cached:false, title: v.title, arxiv_id: v.arxiv_id, block_count: 1 });
    }
    const m = path.match(/^\/api\/paper\/([^/]+)$/);
    if (m && method === 'GET') return j(viewFor(decodeURIComponent(m[1])));
    if (/\/api\/paper\/[^/]+\/qa$/.test(path)) return j({ history: [] });
    if (/\/api\/paper\/[^/]+\/translate$/.test(path)) return j({ translated: [] });
    return j({ error:'not found' }, 404);
  });
}

let fail = 0;
const check = (name, cond, info) => { if (cond) console.log(`  ✓ ${name}`); else { fail++; console.log(`  ✗ ${name}`, info ?? ''); } };

// ── Scenario A: 空 localStorage → 最近列表 ──
{
  const ctx = await br.newContext({ viewport:{width:1280,height:900} });
  const pg = await ctx.newPage();
  await installRoutes(pg);
  importCalled = false; lastListLimit = null;
  await pg.addInitScript(() => { try { localStorage.removeItem('research:last_paper'); } catch {} });
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  await pg.waitForSelector('.recent-list', { timeout: 8000 });
  console.log('=== A: 空 localStorage → 最近列表 ===');
  const rows = await pg.$$eval('.recent-row .recent-name', els => els.map(e => e.textContent));
  check('渲染最近列表（2 条，倒序）', rows.length === 2 && rows[0] === 'Attention Is All You Need', rows);
  check('GET /api/papers limit=30', lastListLimit === '30', lastListLimit);
  check('未触发 import（纯列表路径）', importCalled === false);
  // 点击第一条 → getView 秒开 + 写 last_paper
  await pg.click('.recent-row');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  const opened = await pg.evaluate(() => document.querySelector('#paper-title')?.textContent);
  check('点击秒开（标题切换）', opened === 'Attention Is All You Need', opened);
  const stored = await pg.evaluate(() => localStorage.getItem('research:last_paper'));
  check('写 localStorage last_paper', stored === '1706.03762', stored);
  check('点击走 getView 非 import', importCalled === false);
  await ctx.close();
}

// ── Scenario B: localStorage 已存 → 自动恢复 ──
{
  const ctx = await br.newContext({ viewport:{width:1280,height:900} });
  const pg = await ctx.newPage();
  await installRoutes(pg);
  importCalled = false;
  await pg.addInitScript(() => { try { localStorage.setItem('research:last_paper','2310.06825'); } catch {} });
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  console.log('=== B: localStorage 已存 → 自动恢复 ===');
  const title = await pg.evaluate(() => document.querySelector('#paper-title')?.textContent);
  check('进站自动恢复上次 paper', title === 'Mistral 7B', title);
  const hasRecent = await pg.evaluate(() => !!document.querySelector('.recent-list'));
  check('恢复后不显示最近列表', hasRecent === false);
  check('恢复走 getView 非 import', importCalled === false);
  await ctx.close();
}

// ── Scenario C: URL ?paper= 优先级 > localStorage ──
{
  const ctx = await br.newContext({ viewport:{width:1280,height:900} });
  const pg = await ctx.newPage();
  await installRoutes(pg);
  importCalled = false;
  await pg.addInitScript(() => { try { localStorage.setItem('research:last_paper','2310.06825'); } catch {} });
  await pg.goto(BASE + '/?paper=1706.03762', { waitUntil:'networkidle' });
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  console.log('=== C: URL ?paper= 优先级 > localStorage ===');
  const title = await pg.evaluate(() => document.querySelector('#paper-title')?.textContent);
  check('URL ?paper 优先（非 localStorage 的 2310）', title === 'Attention Is All You Need', title);
  check('URL 路径走 import', importCalled === true);
  await ctx.close();
}

// ── Scenario D: 375px 不溢出 ──
{
  const ctx = await br.newContext({ viewport:{width:375,height:800} });
  const pg = await ctx.newPage();
  await installRoutes(pg);
  await pg.addInitScript(() => { try { localStorage.removeItem('research:last_paper'); } catch {} });
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  await pg.waitForSelector('.recent-list', { timeout: 8000 });
  console.log('=== D: 375px 不溢出 ===');
  const overflow = await pg.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  await ctx.close();
}

console.log(fail ? `\nE2E F2: ${fail} CHECK(S) FAILED ✗` : '\nE2E F2: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
