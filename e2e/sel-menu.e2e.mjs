// F1 fix E2E: 划词选区合并菜单（问 AI + 记笔记不互盖）。
// 场景：
//  A. 划词 → 出现一个 .sel-menu 含两个按钮 [data-action=ask] + [data-action=note]，不互相覆盖（rect 不重叠）。
//  B. 点「记笔记」→ 弹 note-card → 输入 → 存 annotation（POST /annotations）→ 书签出现。
//  C. 点「问 AI」→ 开 QA 抽屉 + scope=selection + block_id 正确（问 AI 零回归）。
//  D. 中英切换：菜单按钮文案跟随（ask AI / 问 AI）。
//  E. 375px 菜单不溢出。
// 跑法：npm run build && (serve dist :4399) && node e2e/sel-menu.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const PAPER_ID = '1706.03762';
const mkBlock = (id, en, zh) => ({
  id, type:'para', sec:'s1', order:0, level:0,
  text_en: en, text_zh: zh, latex:null, img_url:null, caption:null,
  anchor:`sec-${id}`, translate:true, zh_status:'done',
});
const view = {
  paper_id: PAPER_ID, title:'Attention Is All You Need', arxiv_id:PAPER_ID,
  source_url:'https://arxiv.org/abs/'+PAPER_ID, toc:[],
  blocks:[
    mkBlock('b1','The dominant sequence transduction models are based on complex networks.','主流序列转导模型基于复杂网络。'),
    mkBlock('b2','We propose the Transformer architecture.','我们提出 Transformer 架构。'),
  ],
  stats:{total:2,translatable:2,translated:2},
};

let lastAnnotation = null;
let lastAskBody = null;
let annotations = [];

function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path = url.pathname; const method = req.method();
    const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (path === '/api/import' && method==='POST') {
      return j({ paper_id: PAPER_ID, cached:false, title: view.title, arxiv_id: PAPER_ID, block_count: 2 });
    }
    const annColl = path.match(/^\/api\/paper\/[^/]+\/annotations$/);
    if (annColl) {
      if (method==='POST') {
        const b = JSON.parse(req.postData()||'{}');
        lastAnnotation = { id:'an_'+(annotations.length+1), paper_id:PAPER_ID, block_id:b.block_id,
          note_md:b.note_md, quote_snapshot:b.quote_snapshot||null, sel_start:b.sel_start??null, sel_end:b.sel_end??null, created_at:Date.now() };
        annotations.push(lastAnnotation);
        return j({ paper_id:PAPER_ID, annotation:lastAnnotation });
      }
      return j({ paper_id:PAPER_ID, annotations });
    }
    if (/\/api\/paper\/[^/]+\/qa$/.test(path)) {
      if (method==='POST') { lastAskBody = JSON.parse(req.postData()||'{}'); return j({ answer:'The Transformer relies on attention.', cited_block_ids:[lastAskBody.block_id||'b1'], scope:lastAskBody.scope, question:lastAskBody.question, model:'qwen' }); }
      return j({ paper_id:PAPER_ID, history: [] });
    }
    if (/\/api\/paper\/[^/]+\/mindmap$/.test(path)) return j({ markmap_md:'# x', model:'q', lang:'zh', cached:false });
    if (/\/api\/paper\/[^/]+\/translate$/.test(path)) return j({ translated: [] });
    if (/\/api\/paper\/[^/]+$/.test(path) && method==='GET') return j(view);
    if (path === '/api/papers') return j({ papers: [] });
    return j({ error:'not found' }, 404);
  });
}

function selectBlock(blockId) {
  return (id) => {
    const blk = document.querySelector(`[data-block="${id}"]`);
    const textEl = blk.querySelector('.col-en') || blk;
    const range = document.createRange();
    range.selectNodeContents(textEl);
    const sel = window.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  };
}

let fail = 0;
const check = (n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };

async function newPage(viewport) {
  const ctx = await br.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await installRoutes(pg);
  pg.on('pageerror', e => console.log('PAGEERR', e.message));
  return { ctx, pg };
}
async function importAndWait(pg) {
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', PAPER_ID);
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
}

// ── A + B + C + D ──
{
  annotations = []; lastAnnotation = null; lastAskBody = null;
  const { ctx, pg } = await newPage({width:1280,height:900});
  await importAndWait(pg);

  console.log('=== A: 划词出合并菜单（两项不互盖）===');
  await pg.evaluate(selectBlock('b1'), 'b1');
  await pg.waitForSelector('.sel-menu[data-open="1"]', { timeout: 4000 });
  const btns = await pg.$$eval('.sel-menu[data-open="1"] .sel-menu-btn', els => els.map(e=>e.getAttribute('data-action')));
  check('菜单含 ask + note 两项', btns.includes('ask') && btns.includes('note'), btns);
  check('单一菜单（非两个独立浮钮）', (await pg.$$('.sel-menu')).length === 1);
  // 不互盖：两按钮 rect 不重叠
  const overlap = await pg.evaluate(() => {
    const bs = [...document.querySelectorAll('.sel-menu[data-open="1"] .sel-menu-btn')].map(b=>b.getBoundingClientRect());
    if (bs.length<2) return 'lt2';
    const [a,b] = bs;
    return !(a.right <= b.left || b.right <= a.left); // true = 水平重叠
  });
  check('两按钮不水平重叠', overlap === false, overlap);

  console.log('=== B: 点记笔记 → 存 annotation → 书签 ===');
  await pg.click('.sel-menu-btn[data-action="note"]');
  await pg.waitForSelector('.note-card[data-open="1"]', { timeout: 3000 });
  await pg.fill('.note-card-ta', '这是核心贡献');
  await pg.click('.note-card-save');
  await pg.waitForTimeout(500);
  check('POST annotation block_id=b1', lastAnnotation?.block_id==='b1', lastAnnotation);
  check('note_md 落库', lastAnnotation?.note_md==='这是核心贡献');
  check('书签出现在 b1', !!(await pg.$('[data-block="b1"] .note-bookmark')));

  console.log('=== C: 点问 AI → QA 抽屉 scope=selection ===');
  // 先关掉笔记抽屉（上一步 save 后会开），避免两个右侧抽屉重叠。
  await pg.evaluate(()=>{ const d=document.querySelector('#notes-drawer'); if(d) d.dataset.open='0'; });
  await pg.waitForTimeout(150);
  await pg.evaluate(selectBlock('b2'), 'b2');
  await pg.waitForSelector('.sel-menu[data-open="1"]', { timeout: 3000 });
  await pg.click('.sel-menu-btn[data-action="ask"]');
  await pg.waitForSelector('#qa-drawer[data-open="1"]', { timeout: 3000 });
  await pg.fill('#qa-q', 'What is this?');
  await pg.click('#qa-send');
  await pg.waitForTimeout(500);
  check('问 AI scope=selection', lastAskBody?.scope==='selection', lastAskBody);
  check('问 AI block_id=b2', lastAskBody?.block_id==='b2', lastAskBody);

  console.log('=== D: 中英切换菜单文案 ===');
  // 关 QA 抽屉避免遮挡
  await pg.keyboard.press('Escape');
  await pg.evaluate(() => { const z=[...document.querySelectorAll('[data-uilang]')]; });
  // 切到 en
  await pg.click('#uilang-switch button[data-uilang="en"]');
  await pg.waitForTimeout(200);
  await pg.evaluate(selectBlock('b1'), 'b1');
  await pg.waitForSelector('.sel-menu[data-open="1"]', { timeout: 3000 });
  const labels = await pg.$$eval('.sel-menu[data-open="1"] .sel-menu-btn .sel-menu-label', els=>els.map(e=>e.textContent));
  check('en 文案 ask AI / note', labels.some(l=>/ask AI/i.test(l)) && labels.some(l=>/note/i.test(l)), labels);
  await ctx.close();
}

// ── E: 375px 不溢出 ──
{
  annotations = [];
  const { ctx, pg } = await newPage({width:375,height:800});
  await importAndWait(pg);
  console.log('=== E: 375px 菜单不溢出 ===');
  await pg.evaluate(selectBlock('b1'), 'b1');
  await pg.waitForSelector('.sel-menu[data-open="1"]', { timeout: 3000 });
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  const menuRight = await pg.evaluate(()=>{ const m=document.querySelector('.sel-menu[data-open="1"]'); const r=m.getBoundingClientRect(); return { left:r.left, right:r.right, vw:window.innerWidth }; });
  check('菜单在视口内（right≤vw）', menuRight.right <= menuRight.vw + 1 && menuRight.left >= -1, menuRight);
  await ctx.close();
}

console.log(fail ? `\nE2E F1-fix: ${fail} CHECK(S) FAILED ✗` : '\nE2E F1-fix: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
