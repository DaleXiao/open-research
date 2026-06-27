// M5.6 E2E: 选中文字 → 不点 "?" 钮 → 直接点输入框 → 打字 → 发送
// 断言: 请求 scope=selection + block_id=该 block；selHint 显示选中 block；"?" 钮老路径回归。
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });
const ctx = await br.newContext({ viewport:{width:1280,height:900} });
const pg = await ctx.newPage();

const PAPER_ID = '1706.03762';
const mkBlock = (id, sec, order, en, zh) => ({
  id, type:'para', sec, order, level:0,
  text_en: en, text_zh: zh, latex:null, img_url:null, caption:null,
  anchor: `sec-${id}`, translate:true, zh_status:'done',
});
const view = {
  paper_id: PAPER_ID,
  title: 'Attention Is All You Need',
  arxiv_id: PAPER_ID, source_url: 'https://arxiv.org/abs/'+PAPER_ID,
  toc: [],
  blocks: [
    mkBlock('b1','abs',0,'The dominant sequence transduction models are based on complex recurrent or convolutional neural networks in an encoder decoder configuration.','主流的序列转导模型基于复杂的循环或卷积神经网络，采用编码器-解码器结构。'),
    mkBlock('b2','intro',1,'We propose the Transformer, a model architecture eschewing recurrence and relying entirely on attention.','我们提出 Transformer，一种摒弃循环、完全依赖注意力的模型架构。'),
  ],
  stats: { total:2, translatable:2, translated:2 },
};

let lastAskBody = null;

await pg.route('**/api/**', async (route) => {
  const req = route.request();
  const url = req.url(); const method = req.method();
  const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
  // POST /api/import
  if (url.endsWith('/api/import') && method==='POST') {
    return j({ paper_id: PAPER_ID, cached:false, title: view.title, arxiv_id: PAPER_ID, block_count: 2 });
  }
  // qa: POST = ask, GET = history  (/api/paper/:id/qa)
  if (/\/api\/paper\/[^/]+\/qa$/.test(url)) {
    if (method === 'POST') {
      lastAskBody = JSON.parse(req.postData() || '{}');
      return j({ answer: 'The Transformer relies entirely on attention.', cited_block_ids: [lastAskBody.block_id || 'b1'], scope: lastAskBody.scope, question: lastAskBody.question });
    }
    return j({ history: [] });
  }
  // translate
  if (/\/api\/paper\/[^/]+\/translate$/.test(url)) return j({ paper_id:PAPER_ID, translated:[] });
  // GET /api/paper/:id  → view
  if (/\/api\/paper\/[^/]+$/.test(url) && method==='GET') return j(view);
  return j(view);
});

const logs = [];
pg.on('console', m => logs.push(m.text()));
pg.on('pageerror', e => logs.push('PAGEERR ' + e.message));

await pg.goto(BASE + '/', { waitUntil: 'networkidle' });

// import paper
await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', PAPER_ID);
  await pg.keyboard.press('Enter');
await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });

// open QA drawer
await pg.click('#qa-open');
await pg.waitForSelector('#qa-drawer[data-open="1"]');

// ── 核心场景：选中 b1 英文列文字，不点 "?" 钮，直接点输入框 ──
await pg.evaluate(() => {
  const blk = document.querySelector('[data-block="b1"]');
  const textEl = blk.querySelector('.col-en') || blk;
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await pg.waitForTimeout(120);

const selBtnVisible = await pg.evaluate(() => {
  const b = document.querySelector('.sel-menu[data-open="1"] .sel-menu-btn[data-action="ask"]');
  return b && !b.hidden;
});
await pg.click('#qa-q');
await pg.waitForTimeout(100);

const hintAfterFocus = await pg.evaluate(() => {
  const h = document.querySelector('#qa-sel-hint');
  const selBtn = document.querySelector('button[data-scope="selection"]');
  return { hintText: h?.textContent || '', hintHidden: h?.hidden, scopePressed: selBtn?.getAttribute('aria-pressed') };
});

await pg.fill('#qa-q', 'What is the Transformer?');
await pg.click('#qa-send');
await pg.waitForTimeout(500);

const results = {
  selBtnFloatedButNotClicked: selBtnVisible === true,
  hintShowsSelection: hintAfterFocus.hintHidden === false && /b1/.test(hintAfterFocus.hintText),
  scopeSwitchedToSelection: hintAfterFocus.scopePressed === 'true',
  askScopeSelection: lastAskBody?.scope === 'selection',
  askBlockId: lastAskBody?.block_id === 'b1',
};
console.log('RESULT-MAIN ' + JSON.stringify(results));
console.log('ASK-BODY ' + JSON.stringify(lastAskBody));
console.log('HINT ' + JSON.stringify(hintAfterFocus));

// ── 回归：走 "?" 钮老路径 ──
lastAskBody = null;
await pg.evaluate(() => document.querySelector('button[data-scope="full"]').click());
await pg.waitForTimeout(60);
await pg.evaluate(() => {
  const blk = document.querySelector('[data-block="b2"]');
  const textEl = blk.querySelector('.col-en') || blk;
  const range = document.createRange();
  range.selectNodeContents(textEl);
  const sel = window.getSelection();
  sel.removeAllRanges(); sel.addRange(range);
  document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
});
await pg.waitForTimeout(120);
await pg.click('.sel-menu-btn[data-action="ask"]');
await pg.waitForTimeout(100);
await pg.fill('#qa-q', 'Second question via btn');
await pg.click('#qa-send');
await pg.waitForTimeout(500);
console.log('RESULT-REGRESSION ' + JSON.stringify({
  oldPathScopeSelection: lastAskBody?.scope === 'selection',
  oldPathBlockId: lastAskBody?.block_id === 'b2',
}));

// ── full scope 默认（无选区问全文）──
lastAskBody = null;
await pg.evaluate(() => document.querySelector('button[data-scope="full"]').click());
await pg.waitForTimeout(60);
await pg.fill('#qa-q', 'Full scope question');
await pg.click('#qa-send');
await pg.waitForTimeout(500);
console.log('RESULT-FULL ' + JSON.stringify({ fullScope: lastAskBody?.scope === 'full', noBlockId: !lastAskBody?.block_id }));

console.log('--- console logs ---');
for (const l of logs.slice(-15)) console.log(l);

await br.close();
