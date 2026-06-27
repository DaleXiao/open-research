// F3-fix3 E2E: 切换论文后脑图/笔记/翻译/QA 重绑（mindmap 缓存加 paper_id 维度）。
// 场景：导入 A → 生成 A 脑图 → 切 B → 脑图是 B（不是 A 旧缓存）/ QA 历史是 B / 翻译进度是 B；
//   切回 A → 缓存正确。统一 research:paper-change 失效信号。
// markmap CDN stub 离线。跑法：npm run build && (serve dist :4399) && node e2e/paper-switch.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;
const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const A = '1706.03762', B = '2310.06825';
const mkBlock = (id) => ({ id, type:'para', sec:'s', order:0, level:0, text_en:'hello', text_zh:'你好', latex:null, img_url:null, caption:null, anchor:`sec-${id}`, translate:true, zh_status:'done' });
const viewOf = (id, title, translated) => ({ paper_id:id, title, arxiv_id:id, source_url:'https://arxiv.org/abs/'+id, toc:[], blocks:[mkBlock('b1')], stats:{ total:1, translatable:1, translated } });
const VIEWS = {
  [A]: viewOf(A, 'Attention Is All You Need', 1),   // A 全译
  [B]: viewOf(B, 'Mistral 7B', 0),                  // B 未译
};
const QA = {
  [A]: [{ id:'qa-a', question:'what is attention?', answer:'A ans', cited:[], created_at:1 }],
  [B]: [{ id:'qa-b', question:'what is mistral?', answer:'B ans', cited:[], created_at:1 }],
};

let mindmapCalls = [];
function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path = url.pathname; const method = req.method();
    const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (path === '/api/papers') return j({ papers: [
      { id:A, title:'Attention Is All You Need', source_type:'arxiv', arxiv_id:A, block_count:1, created_at:2 },
      { id:B, title:'Mistral 7B', source_type:'arxiv', arxiv_id:B, block_count:1, created_at:1 },
    ] });
    if (path === '/api/import' && method==='POST') {
      const body = JSON.parse(req.postData() || '{}');
      const id = body.url || body.id;
      const v = VIEWS[id];
      return v ? j({ paper_id:id, cached:false, title:v.title, arxiv_id:id, block_count:1 }) : j({ error:'nf' }, 404);
    }
    const mm = path.match(/^\/api\/paper\/([^/]+)\/mindmap$/);
    if (mm && method==='POST') {
      const id = decodeURIComponent(mm[1]);
      const body = JSON.parse(req.postData() || '{}');
      mindmapCalls.push({ id, lang: body.lang });
      // 脑图 md 顶节点带 paper title，方便断言渲染的是哪篇
      const title = VIEWS[id]?.title || id;
      return j({ markmap_md:`# ${title} MINDMAP\n## sec [sec-b1]`, model:'m', lang: body.lang==='en'?'en':'zh', cached:false });
    }
    const qaM = path.match(/^\/api\/paper\/([^/]+)\/qa$/);
    if (qaM && method==='GET') return j({ history: QA[decodeURIComponent(qaM[1])] || [] });
    if (/\/api\/paper\/[^/]+\/annotations$/.test(path)) return j({ paper_id:'x', annotations: [] });
    if (/\/api\/paper\/[^/]+\/translate$/.test(path)) return j({ translated: [], cached_hit:0, skipped_untranslatable:0, remaining:0, has_more:false, failed:[] });
    const gv = path.match(/^\/api\/paper\/([^/]+)$/);
    if (gv && method==='GET') { const v = VIEWS[decodeURIComponent(gv[1])]; return v ? j(v) : j({ error:'nf' }, 404); }
    return j({ error:'not found' }, 404);
  });
}

const MARKMAP_STUB = () => {
  window.markmap = {
    Transformer: class { transform(md) { return { root: { md } }; } },
    Markmap: { create(svg, _o, root) {
      const ns='http://www.w3.org/2000/svg';
      for (const ln of String(root.md||'').split('\n').filter(Boolean)) {
        const g=document.createElementNS(ns,'g'); g.setAttribute('class','markmap-node');
        const tx=document.createElementNS(ns,'text'); tx.textContent=ln.replace(/^[#\-\s]+/,''); g.appendChild(tx); svg.appendChild(g);
      }
      return { fit(){} };
    } },
  };
};

let fail=0; const check=(n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };
function svgText(pg){ return pg.evaluate(()=>document.querySelector('#mindmap-stage svg')?.textContent || ''); }

const ctx = await br.newContext({ viewport:{ width:1280, height:900 } });
const pg = await ctx.newPage();
await pg.addInitScript(MARKMAP_STUB);
await pg.addInitScript(()=>{ try{ localStorage.clear(); }catch{} });
await installRoutes(pg);
pg.on('pageerror', e=>console.log('PAGEERR', e.message));
await pg.goto(BASE+'/', { waitUntil:'networkidle' });
await pg.waitForSelector('#paper-input');

// ── 导入 A（走 dialog）──
async function importPaper(id){
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', id);
  await pg.keyboard.press('Enter');
  await pg.waitForFunction((t)=>document.querySelector("#paper-title")?.textContent===t, VIEWS[id].title, { timeout:3000 });
}

console.log('=== 导入 A + 生成 A 脑图 ===');
await importPaper(A);
await pg.click('#mindmap-open');
await pg.waitForSelector('#mindmap-stage svg .markmap-node', { timeout:3000 });
check('A 脑图渲染 A 内容', /Attention Is All You Need MINDMAP/.test(await svgText(pg)), await svgText(pg));
// 关闭 overlay
await pg.keyboard.press('Escape');

console.log('=== 切到 B（papers 库）===');
await pg.click('#papers-open');
await pg.waitForSelector('.recent-item, .recent-list, [data-paper]', { timeout:3000 }).catch(()=>{});
// 点列表里 B
await pg.evaluate((id)=>{ const el=[...document.querySelectorAll('[data-paper]')].find(e=>e.getAttribute('data-paper')===id); (el?.querySelector('button')||el)?.click(); }, B);
await pg.waitForFunction((t)=>document.querySelector('#paper-title')?.textContent===t, VIEWS[B].title, { timeout:3000 });
check('切 B：标题更新', (await pg.evaluate(()=>document.querySelector('#paper-title')?.textContent)) === 'Mistral 7B');

console.log('=== 开脑图 → 必须是 B 不是 A 旧缓存（核心 bug）===');
mindmapCalls = [];
await pg.click('#mindmap-open');
await pg.waitForSelector('#mindmap-stage svg .markmap-node', { timeout:3000 });
const bText = await svgText(pg);
check('B 脑图渲染 B 内容（非 A 旧缓存）', /Mistral 7B MINDMAP/.test(bText), bText);
check('B 脑图不含 A 残留', !/Attention Is All You Need/.test(bText), bText);
check('切 B 后重打后端（含 B paper_id）', mindmapCalls.some(c=>c.id===B), mindmapCalls);
await pg.keyboard.press('Escape');

console.log('=== QA 历史随切换重绑 ===');
await pg.click('#qa-open');
await pg.waitForTimeout(300);
const qaText = await pg.evaluate(()=>document.querySelector('#qa-history')?.textContent || '');
check('QA 历史是 B（mistral）', /mistral/i.test(qaText), qaText);
check('QA 历史不含 A', !/attention/i.test(qaText), qaText);
await pg.click('#qa-close').catch(()=>{});

console.log('=== 翻译进度随切换干净 ===');
const prog = await pg.evaluate(()=>document.querySelector('#progress')?.textContent || '');
check('B 进度 0/1（未译，非 A 的 1/1）', /0\s*\/\s*1/.test(prog), prog);

console.log('=== 切回 A → 脑图缓存正确 ===');
await pg.click('#papers-open');
await pg.waitForTimeout(200);
await pg.evaluate((id)=>{ const el=[...document.querySelectorAll('[data-paper]')].find(e=>e.getAttribute('data-paper')===id); (el?.querySelector('button')||el)?.click(); }, A);
await pg.waitForFunction((t)=>document.querySelector('#paper-title')?.textContent===t, VIEWS[A].title, { timeout:3000 });
await pg.click('#mindmap-open');
await pg.waitForSelector('#mindmap-stage svg .markmap-node', { timeout:3000 });
const aBack = await svgText(pg);
check('切回 A 脑图是 A', /Attention Is All You Need MINDMAP/.test(aBack), aBack);
check('切回 A 不含 B 残留', !/Mistral/.test(aBack), aBack);

await ctx.close();
console.log(fail ? `\nF3-fix3 paper-switch: ${fail} CHECK(S) FAILED ✗` : '\nF3-fix3 paper-switch: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
