// F4 E2E: 思维导图 markmap overlay。
// 场景：
//  A. 导入 paper → 点顶栏 mindmap 按钮 → overlay 打开 + POST /api/mindmap(lang=zh) + 渲染 SVG。
//  B. 点 regenerate → POST 带 force=true。
//  C. 切 view 语言 en → overlay 内 SVG 销毁重建 + POST lang=en。
//  D. 空 paper 点 mindmap → 提示 needPaper，不打后端。
//  E. 375px overlay 满屏可用。
// markmap CDN 在测试环境 stub 成 window.markmap（离线，不依赖真 CDN）。
// 跑法：npm run build && (serve dist :4399) && node e2e/mindmap.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

const PAPER_ID = '1706.03762';
const mkBlock = (id) => ({
  id, type:'para', sec:'s', order:0, level:0,
  text_en:'hello world', text_zh:'你好世界', latex:null, img_url:null, caption:null,
  anchor:`sec-${id}`, translate:true, zh_status:'done',
});
const view = {
  paper_id: PAPER_ID, title:'Attention Is All You Need', arxiv_id:PAPER_ID,
  source_url:'https://arxiv.org/abs/'+PAPER_ID, toc:[],
  blocks:[mkBlock('b1')], stats:{total:1,translatable:1,translated:1},
};

let mindmapCalls = [];

function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path = url.pathname; const method = req.method();
    const j = (obj, status=200) => route.fulfill({ status, contentType:'application/json', body: JSON.stringify(obj) });
    if (path === '/api/import' && method==='POST') {
      return j({ paper_id: PAPER_ID, cached:false, title: view.title, arxiv_id: PAPER_ID, block_count: 1 });
    }
    const mm = path.match(/^\/api\/paper\/[^/]+\/mindmap$/);
    if (mm && method==='POST') {
      const body = JSON.parse(req.postData() || '{}');
      mindmapCalls.push(body);
      const lang = body.lang === 'en' ? 'en' : 'zh';
      const md = lang === 'en'
        ? '# Attention\n## Method\n- Self-attention [sec-b1]\n## Results'
        : '# 注意力\n## 方法\n- 自注意力 [sec-b1]\n## 结果';
      return j({ markmap_md: md, model:'qwen3.6-plus', lang, cached:false });
    }
    if (/\/api\/paper\/[^/]+\/qa$/.test(path)) return j({ history: [] });
    if (/\/api\/paper\/[^/]+\/annotations$/.test(path)) return j({ paper_id:PAPER_ID, annotations: [] });
    if (/\/api\/paper\/[^/]+\/translate$/.test(path)) return j({ translated: [] });
    if (/\/api\/paper\/[^/]+$/.test(path) && method==='GET') return j(view);
    if (path === '/api/papers') return j({ papers: [] });
    return j({ error:'not found' }, 404);
  });
}

// 离线 stub window.markmap（Transformer.transform + Markmap.create 造一个真 <g> 节点带引用文本）。
const MARKMAP_STUB = () => {
  window.markmap = {
    Transformer: class { transform(md) { return { root: { md } }; } },
    Markmap: {
      create(svg, _opts, root) {
        const ns = 'http://www.w3.org/2000/svg';
        // 为每行造一个 g.markmap-node，文字含 [sec-xx] 让 bindNodeJump 命中。
        const lines = String(root.md || '').split('\n').filter(Boolean);
        for (const ln of lines) {
          const g = document.createElementNS(ns, 'g');
          g.setAttribute('class', 'markmap-node');
          const txt = document.createElementNS(ns, 'text');
          txt.textContent = ln.replace(/^[#\-\s]+/, '');
          g.appendChild(txt);
          svg.appendChild(g);
        }
        return { fit(){} };
      },
    },
  };
};

let fail = 0;
const check = (n,c,i)=>{ if(c) console.log(`  ✓ ${n}`); else { fail++; console.log(`  ✗ ${n}`, i??''); } };

async function newPage(viewport) {
  const ctx = await br.newContext({ viewport });
  const pg = await ctx.newPage();
  await pg.addInitScript(MARKMAP_STUB);
  await pg.addInitScript(() => { try { localStorage.clear(); } catch {} });
  await installRoutes(pg);
  return { ctx, pg };
}

async function importAndWait(pg) {
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  // import 改为 dialog（#paper-input readonly 触发器）。点开 → 输入 → Enter。
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', PAPER_ID);
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
}

// ── A + B + C: 主流程 ──
{
  mindmapCalls = [];
  const { ctx, pg } = await newPage({width:1280,height:900});
  await importAndWait(pg);
  console.log('=== A: 打开 mindmap → 渲染 ===');
  await pg.click('#mindmap-open');
  await pg.waitForSelector('#mindmap-overlay[data-open="1"]', { timeout: 4000 });
  await pg.waitForSelector('#mindmap-stage svg.mindmap-svg g.markmap-node', { timeout: 6000 });
  const svgCount = await pg.$$eval('#mindmap-stage svg', s => s.length);
  check('overlay 打开', await pg.evaluate(()=>document.querySelector('#mindmap-overlay').dataset.open==='1'));
  check('渲染 1 个 SVG', svgCount === 1, svgCount);
  check('POST mindmap lang=zh', mindmapCalls.length===1 && mindmapCalls[0].lang==='zh', mindmapCalls);
  check('节点渲染（含引用）', (await pg.$$('#mindmap-stage g.markmap-node')).length >= 3);

  console.log('=== B: regenerate → force ===');
  await pg.click('#mindmap-regen');
  await pg.waitForTimeout(400);
  check('POST 带 force=true', mindmapCalls.some(c=>c.force===true), mindmapCalls);
  check('regen 后仍只 1 个 SVG（销毁重建）', (await pg.$$eval('#mindmap-stage svg', s=>s.length))===1);

  console.log('=== C: 关闭 → 切 view 语言 en → 重开 → 销毁重建 ===');
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(150);
  check('Esc 关闭 overlay', (await pg.evaluate(()=>document.querySelector('#mindmap-overlay').dataset.open))==='0');
  await pg.click('#view-seg button[data-mode="en"]');
  await pg.waitForTimeout(150);
  await pg.click('#mindmap-open');
  await pg.waitForSelector('#mindmap-overlay[data-open="1"]', { timeout: 4000 });
  await pg.waitForTimeout(500);
  check('重开触发 POST lang=en', mindmapCalls.some(c=>c.lang==='en'), mindmapCalls);
  check('en 后仍只 1 个 SVG（销毁重建）', (await pg.$$eval('#mindmap-stage svg', s=>s.length))===1);

  console.log('=== close（点遮罩空白）===');
  await pg.evaluate(()=>{ const o=document.querySelector('#mindmap-overlay'); o.dispatchEvent(new MouseEvent('click',{bubbles:true})); });
  await pg.waitForTimeout(200);
  // 点遮罩自身才关；用 Esc 兜底确保关闭态
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(150);
  check('overlay 已关闭', (await pg.evaluate(()=>document.querySelector('#mindmap-overlay').dataset.open))==='0');
  await ctx.close();
}

// ── D: 空 paper 点 mindmap ──
{
  mindmapCalls = [];
  const { ctx, pg } = await newPage({width:1280,height:900});
  await pg.goto(BASE + '/', { waitUntil:'networkidle' });
  console.log('=== D: 空 paper 点 mindmap ===');
  await pg.click('#mindmap-open');
  await pg.waitForTimeout(400);
  const status = await pg.evaluate(()=>document.querySelector('#mindmap-status')?.textContent || '');
  check('提示 needPaper', /import a paper|导入论文/.test(status), status);
  check('空 paper 不打后端', mindmapCalls.length===0, mindmapCalls);
  await ctx.close();
}

// ── E: 375px 满屏 ──
{
  const { ctx, pg } = await newPage({width:375,height:800});
  await importAndWait(pg);
  console.log('=== E: 375px overlay 满屏 ===');
  await pg.click('#mindmap-open');
  await pg.waitForSelector('#mindmap-stage svg.mindmap-svg', { timeout: 6000 });
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  const panelW = await pg.evaluate(()=>document.querySelector('.mindmap-panel')?.getBoundingClientRect().width);
  check('panel 满屏宽', panelW >= 374, panelW);
  await ctx.close();
}

console.log(fail ? `\nE2E F4: ${fail} CHECK(S) FAILED ✗` : '\nE2E F4: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
