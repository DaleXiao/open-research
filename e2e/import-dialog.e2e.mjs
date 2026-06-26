// F8 E2E: import 弹框交互 — 点击 import 触发器弹 dialog 输 url。
// 场景：
//  A. 顶栏 import 输入框 readonly（不可直接键入）；点击/点按钮 → 弹 role=dialog aria-modal。
//  B. dialog 内有标题/提示/输入框/确认+取消钮；focus 自动落输入框。
//  C. 取消钮关闭；Esc 关闭；点遮罩关闭（dialog 消失，无 import 请求）。
//  D. 输入 arxiv id + Enter 提交 → POST /api/import（url 正确），成功后 dialog 自关 + 论文加载。
//  E. i18n：切 EN 后 dialog 文案为英文。
//  F. 375px：dialog 不横向溢出。
// 跑法：npm run build && (serve dist :4399) && node e2e/import-dialog.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const mkBlock = (id) => ({ id, type:'para', sec:'s', order:0, level:0, text_en:'hello', text_zh:'你好', latex:null, img_url:null, caption:null, anchor:`sec-${id}`, translate:true, zh_status:'done' });
const viewFor = (id) => ({ paper_id:id, title:'Attention Is All You Need', arxiv_id:id, source_url:'https://arxiv.org/abs/'+id, toc:[], blocks:[mkBlock('b1')], stats:{ total:1, translatable:1, translated:1 } });

let importBodies = [];
function installRoutes(pg){
  // 解析挪客户端——浏览器直接 fetch arxiv.org HTML，mock 一个最小 LaTeXML 结构。
  pg.route('**/arxiv.org/html/**', async (route) => {
    const html = `<!doctype html><html><body><article class="ltx_document">
      <h1 class="ltx_title_document">Attention Is All You Need</h1>
      <div class="ltx_abstract"><p class="ltx_p" id="abs1">We propose the Transformer.</p></div>
      <section class="ltx_section" id="S1"><h2>Introduction</h2>
        <div class="ltx_para"><p class="ltx_p" id="S1.p1">Intro paragraph here.</p></div>
      </section></article></body></html>`;
    return route.fulfill({ status:200, contentType:'text/html', body:html });
  });
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path = url.pathname; const method = req.method();
    const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (path === '/api/papers' && method === 'GET') return j({ papers: [] });
    if (path === '/api/import' && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      importBodies.push(body);
      // worker 返 ready（前端已解析，只校验落库）。
      return j({ paper_id:body.paper_id, status:'ready', cached:false, title:body.title, arxiv_id:body.arxiv_id, source_type:body.source_type, block_count:(body.blocks||[]).length });
    }
    const m = path.match(/^\/api\/paper\/([^/]+)$/);
    if (m && method === 'GET') return j(viewFor(decodeURIComponent(m[1])));
    if (/\/api\/paper\/[^/]+\/qa$/.test(path)) return j({ history: [] });
    return j({ error:'nf' }, 404);
  });
}

let fail=0; const check=(n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };
async function newPage(vp, theme){ const ctx=await br.newContext({viewport:vp}); const pg=await ctx.newPage(); await pg.addInitScript((t)=>{try{localStorage.clear();if(t)localStorage.setItem('research.theme',t)}catch{}},theme); await installRoutes(pg); pg.on('pageerror',e=>console.log('PAGEERR',e.message)); return {ctx,pg}; }

// ── A/B: readonly 触发器 + 弹 dialog + 焦点 ──
{
  importBodies = [];
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');

  console.log('=== A: 顶栏 readonly + 点击弹 dialog ===');
  const ro = await pg.evaluate(()=>document.querySelector('#paper-input').readOnly);
  check('顶栏 import 输入框 readonly', ro === true);
  let dlgBefore = await pg.evaluate(()=>!!document.querySelector('.import-overlay'));
  check('初始无 dialog', !dlgBefore);

  await pg.click('#paper-input');
  await pg.waitForSelector('.import-overlay', { timeout: 2000 });
  console.log('=== B: dialog 结构 + 焦点 ===');
  const struct = await pg.evaluate(()=>{
    const ov = document.querySelector('.import-overlay');
    return {
      role: ov?.getAttribute('role'),
      modal: ov?.getAttribute('aria-modal'),
      hasTitle: !!ov?.querySelector('.import-dialog-title'),
      hasHint: !!ov?.querySelector('.import-dialog-hint'),
      hasInput: !!ov?.querySelector('.import-dialog-input'),
      hasOk: !!ov?.querySelector('.import-dialog-ok'),
      hasCancel: !!ov?.querySelector('.confirm-cancel'),
    };
  });
  check('role=dialog', struct.role === 'dialog', struct.role);
  check('aria-modal=true', struct.modal === 'true', struct.modal);
  check('有标题/提示/输入框/确认/取消', struct.hasTitle && struct.hasHint && struct.hasInput && struct.hasOk && struct.hasCancel, struct);
  // 焦点落输入框（setTimeout 40ms）
  await pg.waitForTimeout(80);
  const focused = await pg.evaluate(()=>document.activeElement?.classList.contains('import-dialog-input'));
  check('焦点自动落 dialog 输入框', focused === true);
  await ctx.close();
}

// ── C: 三种取消方式 ──
{
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== C: 取消钮 / Esc / 遮罩 关闭 ===');

  // 取消钮
  await pg.click('#import-btn');
  await pg.waitForSelector('.import-overlay');
  await pg.click('.import-overlay .confirm-cancel');
  await pg.waitForTimeout(50);
  check('取消钮关闭 dialog', !(await pg.evaluate(()=>!!document.querySelector('.import-overlay'))));

  // Esc
  await pg.click('#import-btn');
  await pg.waitForSelector('.import-overlay');
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(50);
  check('Esc 关闭 dialog', !(await pg.evaluate(()=>!!document.querySelector('.import-overlay'))));

  // 遮罩
  await pg.click('#import-btn');
  await pg.waitForSelector('.import-overlay');
  await pg.evaluate(()=>{ const ov=document.querySelector('.import-overlay'); const r=ov.getBoundingClientRect(); ov.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
  await pg.waitForTimeout(50);
  check('点遮罩关闭 dialog', !(await pg.evaluate(()=>!!document.querySelector('.import-overlay'))));
  await ctx.close();
}

// ── D: 提交走 import ──
{
  importBodies = [];
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== D: 输入 + Enter 提交 → POST /api/import + 自关 + 加载 ===');

  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '1706.03762');
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(300);
  check('POST /api/import 调用一次', importBodies.length === 1, importBodies);
  // body 现为前端已解析的 payload（paper_id + blocks），不再是 {url}。
  check('import body paper_id 正确', importBodies[0]?.paper_id === '1706.03762', importBodies[0]);
  check('import body 带已解析 blocks', Array.isArray(importBodies[0]?.blocks) && importBodies[0].blocks.length >= 1, importBodies[0]?.blocks?.length);
  check('import body block id 稳定（abs1/S1.p1）', (importBodies[0]?.blocks||[]).some(b=>b.id==='S1.p1'), importBodies[0]?.blocks?.map(b=>b.id));
  check('提交成功后 dialog 自关', !(await pg.evaluate(()=>!!document.querySelector('.import-overlay'))));
  const title = await pg.evaluate(()=>document.querySelector('#paper-title')?.textContent || '');
  check('论文加载（标题更新）', /Attention/.test(title), title);
  await ctx.close();
}

// ── E: i18n EN ──
{
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.addInitScript(()=>{try{localStorage.setItem('research.uiLang','en')}catch{}});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== E: i18n EN dialog 文案 ===');
  await pg.click('#import-btn');
  await pg.waitForSelector('.import-overlay');
  const txt = await pg.evaluate(()=>({ title:document.querySelector('.import-dialog-title')?.textContent||'', ok:document.querySelector('.import-dialog-ok')?.textContent||'', cancel:document.querySelector('.confirm-cancel')?.textContent||'' }));
  check('EN 标题=import paper', /import/i.test(txt.title), txt.title);
  check('EN 确认=import', /import/i.test(txt.ok), txt.ok);
  check('EN 取消=cancel', /cancel/i.test(txt.cancel), txt.cancel);
  await ctx.close();
}

// ── F: 375px 不溢出 ──
{
  const { ctx, pg } = await newPage({width:375,height:800}, 'night');
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== F: 375px dialog 不溢出 ===');
  await pg.click('#import-btn');
  await pg.waitForSelector('.import-overlay');
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px dialog 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  const cardW = await pg.evaluate(()=>document.querySelector('.import-card')?.getBoundingClientRect().width || 0);
  check('卡片宽度 ≤ 视口', cardW <= 375, cardW);
  await ctx.close();
}

// ── G: — PDF fallback 路径 fetch 为 CORS 简单请求（无 Accept 多值头）──
// arxiv /html/ → 404，代码回退 PDF 底座。验证：PDF fetch 请求**不带多值 Accept 头**
// （原 'application/pdf,*/*' 含逗号 → 触发 preflight → arxiv /pdf/ OPTIONS 无 CORS 头 → Failed to fetch）。
// 若代码退回简单请求则压根本不发 OPTIONS，直走 GET。
{
  let pdfGetSeen = 0;
  let optionsSeen = 0;
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  await pg.route('**/arxiv.org/html/**', async (route)=> route.fulfill({ status:404, contentType:'text/html', body:'not found' }));
  await pg.route('**/arxiv.org/pdf/**', async (route)=>{
    const r = route.request();
    if (r.method() === 'OPTIONS') { optionsSeen++; return route.fulfill({ status:200, body:'' }); }
    // 注：浏览器默认 Accept=*/* 不可避免且是 safelisted（不触发 preflight）；
    // 真正该验的是代码没显设多值 Accept → 不发 OPTIONS。记录 GET 发生。
    pdfGetSeen++;
    return route.fulfill({ status:200, contentType:'application/pdf', body:'%PDF-1.4 minimal' });
  });
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== G: PDF fallback fetch 为 CORS 简单请求 ===');
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '2507.19457');
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(800);
  // 根因修复的决定性验证：去掉多值 Accept 后 PDF fetch 为 CORS 简单请求 → 零 preflight OPTIONS。
  check('arxiv /pdf/ 未收到 preflight OPTIONS（简单请求，原多值 Accept 会触发）', optionsSeen === 0, `OPTIONS=${optionsSeen}`);
  check('PDF GET 请求有发出（fallback 路径走通）', pdfGetSeen >= 1, `GET=${pdfGetSeen}`);
  await ctx.close();
}

// ── H: — arXiv HTML fetch 被 CORS 拦截(404 无 ACAO) → fetch_failed 也回退 PDF ──
// 真实场景：arxiv /html/ 的 404 响应不带 ACAO 头 → 浏览器在代码拿到 404 前就拦截 fetch 招 TypeError。
// route.abort() 使 fetch reject(TypeError)——与 CORS 拦截行为等价（代码拿不到状态码，归 fetch_failed）。
// 验证：fetch_failed 也回退 PDF（而非直接报错）——根因修复。
{
  let pdfGetSeen = 0;
  const { ctx, pg } = await newPage({width:1280,height:900}, 'night');
  // html/ fetch 被 abort → reject TypeError（模拟 CORS 拦，代码拿不到 404）。
  await pg.route('**/arxiv.org/html/**', async (route)=> route.abort());
  await pg.route('**/arxiv.org/pdf/**', async (route)=>{
    const r = route.request();
    if (r.method() === 'OPTIONS') return route.fulfill({ status:200, body:'' });
    pdfGetSeen++;
    return route.fulfill({ status:200, contentType:'application/pdf', body:'%PDF-1.4 minimal' });
  });
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('#paper-input');
  console.log('=== H: HTML fetch CORS 拦(fetch_failed) → 回退 PDF ===');
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '2507.19457');
  await pg.keyboard.press('Enter');
  await pg.waitForTimeout(1000); // 等 html abort → fetch_failed → PDF fallback
  // 决定性验证：HTML fetch 报 fetch_failed 后，代码应回退去 fetch PDF（而非直接报错）。
  check('HTML fetch_failed → 回退 PDF（PDF GET 有发出，未直接报错）', pdfGetSeen >= 1, `GET=${pdfGetSeen}`);
  await ctx.close();
}

console.log(fail ? `\nE2E F8 import-dialog: ${fail} CHECK(S) FAILED ✗` : '\nE2E F8 import-dialog: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
