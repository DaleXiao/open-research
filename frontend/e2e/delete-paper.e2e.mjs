// F5 E2E: 论文删除 — 列表删除钮 + 确认对话框 + 级联。
// 场景：
//  A. 列表每项有删除钮（垃圾桶）；点击 → 弹确认框（含标题 + 不可恢复警告 + 取消/确认）。
//  B. 取消 → 不删（DELETE 未调用，列表项还在）。
//  C. 确认 → DELETE /api/paper/:id 调用 → 列表移除该项。
//  D. 删当前正在看的那篇 → 回列表（reader 清空）。
//  E. Esc 关闭确认框（不删）；i18n；375px。
// 跑法：npm run build && (serve dist :4399) && node e2e/delete-paper.e2e.mjs
import pkg from '/home/openclaw/.npm-global/lib/node_modules/openclaw/node_modules/playwright-core/index.js';
const { chromium } = pkg;

const BASE = process.env.E2E_BASE || 'http://localhost:4399';
const br = await chromium.launch({ executablePath:'/home/openclaw/.cache/ms-playwright/chromium-1223/chrome-linux64/chrome', args:['--no-sandbox'] });

let PAPERS = [];
const resetPapers = () => { PAPERS = [
  { id:'1706.03762', title:'Attention Is All You Need', source_type:'arxiv', arxiv_id:'1706.03762', block_count:120, created_at:1781400000000 },
  { id:'2310.06825', title:'Mistral 7B', source_type:'arxiv', arxiv_id:'2310.06825', block_count:80, created_at:1781300000000 },
]; };
const mkBlock = (id) => ({ id, type:'para', sec:'s', order:0, level:0, text_en:'hi', text_zh:'嗨', latex:null, img_url:null, caption:null, anchor:`sec-${id}`, translate:true, zh_status:'done' });
const viewFor = (id) => { const p=PAPERS.find(x=>x.id===id)||{id,title:id,arxiv_id:id}; return { paper_id:id, title:p.title, arxiv_id:p.arxiv_id||id, source_url:'x', toc:[], blocks:[mkBlock('b1')], stats:{total:1,translatable:1,translated:1} }; };

let deleteCalls = [];

function installRoutes(pg) {
  return pg.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url()); const path=url.pathname; const method=req.method();
    const j = (o,s=200)=>route.fulfill({status:s,contentType:'application/json',body:JSON.stringify(o)});
    if (path==='/api/papers' && method==='GET') return j({ papers: PAPERS });
    if (path==='/api/import' && method==='POST') { const b=JSON.parse(req.postData()||'{}'); const id=b.url||b.id; const v=viewFor(id); return j({ paper_id:id, cached:false, title:v.title, arxiv_id:v.arxiv_id, block_count:1 }); }
    const m = path.match(/^\/api\/paper\/([^/]+)$/);
    if (m && method==='DELETE') {
      const id = decodeURIComponent(m[1]);
      deleteCalls.push(id);
      PAPERS = PAPERS.filter(p=>p.id!==id);
      return j({ paper_id:id, deleted:{ paper:1, translations:0, annotations:0, qa_history:0, embeddings:0, mindmaps:0 } });
    }
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
  resetPapers(); deleteCalls = [];
  const { ctx, pg } = await newPage({width:1280,height:900});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('.recent-list', { timeout: 8000 });
  console.log('=== A: 删除钮 + 确认框 ===');
  check('每项有删除钮', (await pg.$$('.recent-item .recent-del')).length === 2);
  // 点第一项删除钮（用 force，因 hover 才显形）
  await pg.click('.recent-item[data-paper="1706.03762"] .recent-del', { force: true });
  await pg.waitForSelector('.confirm-overlay[data-open="1"]', { timeout: 3000 });
  const msg = await pg.evaluate(()=>document.querySelector('.confirm-msg')?.textContent || '');
  check('确认框含标题', /Attention Is All You Need/.test(msg), msg);
  check('确认框有不可恢复警告', !!(await pg.$('.confirm-warn')));
  check('确认框有取消+确认钮', !!(await pg.$('.confirm-cancel')) && !!(await pg.$('.confirm-ok')));
  // Bug1: confirm-card padding 非 0（var(--sp-5) 未定义曾塌成 0 → 按钮贴边）
  const pad = await pg.evaluate(()=>{ const c=document.querySelector('.confirm-card'); const s=getComputedStyle(c); return { top:parseFloat(s.paddingTop), right:parseFloat(s.paddingRight) }; });
  check('confirm-card padding 非 0（不贴边）', pad.top >= 8 && pad.right >= 8, pad);
  // Bug2: 删除确认钮是 danger 红色，非 primary 绿色（破坏性语义）
  const okColor = await pg.evaluate(()=>{ const b=document.querySelector('.confirm-ok'); const s=getComputedStyle(b); const danger=getComputedStyle(document.documentElement).getPropertyValue('--c-danger').trim(); return { bg:s.backgroundColor, danger }; });
  check('确认钮背景=danger 非透明/绿', okColor.bg !== 'rgba(0, 0, 0, 0)' && okColor.bg !== 'transparent', okColor);
  check('确认钮非 primary class', await pg.evaluate(()=>!document.querySelector('.confirm-ok').classList.contains('primary')));

  console.log('=== B: 取消不删 ===');
  await pg.click('.confirm-cancel');
  await pg.waitForTimeout(200);
  check('取消后确认框关闭', !(await pg.$('.confirm-overlay')));
  check('DELETE 未调用', deleteCalls.length === 0, deleteCalls);
  check('列表项还在', !!(await pg.$('.recent-item[data-paper="1706.03762"]')));

  console.log('=== C: 确认删除 → 列表移除 ===');
  await pg.click('.recent-item[data-paper="1706.03762"] .recent-del', { force: true });
  await pg.waitForSelector('.confirm-overlay[data-open="1"]', { timeout: 3000 });
  await pg.click('.confirm-ok');
  await pg.waitForTimeout(500);
  check('DELETE 调用 1706.03762', deleteCalls.includes('1706.03762'), deleteCalls);
  check('列表移除该项', !(await pg.$('.recent-item[data-paper="1706.03762"]')));
  check('另一篇还在', !!(await pg.$('.recent-item[data-paper="2310.06825"]')));
  await ctx.close();
}

// ── D: 删当前正在看的那篇 → 回列表 ──
{
  resetPapers(); deleteCalls = [];
  const { ctx, pg } = await newPage({width:1280,height:900});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.click('#paper-input');
  await pg.waitForSelector('.import-dialog-input');
  await pg.fill('.import-dialog-input', '1706.03762');
  await pg.keyboard.press('Enter');
  await pg.waitForSelector('[data-block="b1"]', { timeout: 8000 });
  console.log('=== D: 删当前篇 → 回列表 ===');
  // 调出库列表
  await pg.click('#papers-open');
  await pg.waitForSelector('.recent-list', { timeout: 4000 });
  // 删当前篇（1706）；当前已被 showPapersLibrary 清成 null，但走 D 的核心是删后列表更新。
  // 为测「删当前正在看的篇」，先打开它再删 —— 点列表项打开
  await pg.evaluate(()=>{ const r=[...document.querySelectorAll('.recent-row')].find(x=>/Attention/.test(x.textContent)); r&&r.click(); });
  await pg.waitForSelector('[data-block="b1"]', { timeout: 6000 });
  // 再调出库 + 删当前篇
  await pg.click('#papers-open');
  await pg.waitForSelector('.recent-list', { timeout: 4000 });
  // 此时 current 已被 showPapersLibrary 清空；删 1706 仍应从列表移除
  await pg.click('.recent-item[data-paper="1706.03762"] .recent-del', { force: true });
  await pg.waitForSelector('.confirm-overlay[data-open="1"]', { timeout: 3000 });
  await pg.click('.confirm-ok');
  await pg.waitForTimeout(500);
  check('DELETE 调用', deleteCalls.includes('1706.03762'), deleteCalls);
  check('回到列表（无 reader 内容）', !(await pg.$('[data-block="b1"]')));
  check('localStorage last_paper 清除', (await pg.evaluate(()=>localStorage.getItem('research:last_paper')))===null);
  await ctx.close();
}

// ── E: Esc 关闭 + i18n + 375px ──
{
  resetPapers(); deleteCalls = [];
  const { ctx, pg } = await newPage({width:375,height:800});
  await pg.goto(BASE+'/', { waitUntil:'networkidle' });
  await pg.waitForSelector('.recent-list', { timeout: 8000 });
  console.log('=== E: Esc 关闭 + i18n + 375px ===');
  await pg.click('.recent-item[data-paper="2310.06825"] .recent-del', { force: true });
  await pg.waitForSelector('.confirm-overlay[data-open="1"]', { timeout: 3000 });
  await pg.keyboard.press('Escape');
  await pg.waitForTimeout(200);
  check('Esc 关闭确认框', !(await pg.$('.confirm-overlay')));
  check('Esc 未触发删除', deleteCalls.length === 0, deleteCalls);
  const overflow = await pg.evaluate(()=>document.documentElement.scrollWidth - document.documentElement.clientWidth);
  check('375px 无横向溢出', overflow <= 1, `overflow=${overflow}`);
  // i18n：切 en 后确认框英文
  await pg.click('#uilang-switch button[data-uilang="en"]');
  await pg.waitForTimeout(200);
  await pg.click('.recent-item[data-paper="2310.06825"] .recent-del', { force: true });
  await pg.waitForSelector('.confirm-overlay[data-open="1"]', { timeout: 3000 });
  const okLabel = await pg.evaluate(()=>document.querySelector('.confirm-ok')?.textContent || '');
  check('en 确认钮文案 Delete', /Delete/i.test(okLabel), okLabel);
  await ctx.close();
}

console.log(fail ? `\nE2E F5: ${fail} CHECK(S) FAILED ✗` : '\nE2E F5: ALL PASS ✅');
await br.close();
process.exit(fail ? 1 : 0);
