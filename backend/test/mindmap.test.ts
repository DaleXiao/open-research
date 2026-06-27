// iter2 F4 思维导图单测：prompt 拼接 + toc 提纲 + section 精华 +
// 围栏剥离 + 缓存命中/force 重生 + 切语言独立缓存 + 空论文边界（mock gateway，离线）。
// 跑法：npx tsx test/mindmap.test.ts

import {
  tocOutline,
  sectionEssence,
  buildMindmapPrompt,
  stripCodeFence,
  generateMindmap,
  MINDMAP_MODEL,
  MINDMAP_MAX_TOKENS,
} from "../src/mindmap/engine.js";
import { savePaper, getMindmap, type D1Like } from "../src/store/d1.js";
import { mindmapPaper, type ServiceCtx } from "../src/service.js";
import type { Block, ParsedPaper, SectionNode } from "../src/parse/types.js";
import type { GatewayConfig } from "../src/llm/gateway.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

// ---- 内存 D1 mock：papers + mindmaps ----
function memDb(): D1Like {
  const tables: Record<string, any[]> = { papers: [], mindmaps: [] };
  function run(query: string, binds: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO papers")) {
      const [id, source_url, source_type, title, arxiv_id, block_count, blocks_json, created_at] =
        binds as any[];
      const ex = tables.papers.find((r) => r.id === id);
      const row = { id, source_url, source_type, title, arxiv_id, status: "parsed", block_count, blocks_json, created_at, updated_at: created_at };
      if (ex) Object.assign(ex, row);
      else tables.papers.push(row);
      return;
    }
    if (q.startsWith("INSERT OR REPLACE INTO mindmaps")) {
      const [paper_id, lang, markmap_md, model, created_at] = binds as any[];
      const ex = tables.mindmaps.find((r) => r.paper_id === paper_id && r.lang === lang);
      const row = { paper_id, lang, markmap_md, model, created_at };
      if (ex) Object.assign(ex, row);
      else tables.mindmaps.push(row);
      return;
    }
  }
  function select(query: string, binds: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT blocks_json FROM papers")) {
      const row = tables.papers.find((r) => r.id === binds[0]);
      return row ? [{ blocks_json: row.blocks_json }] : [];
    }
    if (q.includes("FROM mindmaps")) {
      return tables.mindmaps.filter((r) => r.paper_id === binds[0] && r.lang === binds[1]);
    }
    return [];
  }
  return {
    prepare(query: string) {
      let binds: unknown[] = [];
      const stmt: any = {
        bind(...vals: unknown[]) { binds = vals; return stmt; },
        async first<T>() { const rows = select(query, binds); return (rows[0] as T) ?? null; },
        async all<T>() { return { results: select(query, binds) as T[] }; },
        async run() { run(query, binds); return {}; },
      };
      return stmt;
    },
  };
}

function mkBlock(p: Partial<Block>): Block {
  return {
    id: "b1", type: "para", sec: "S1", order: 0, level: 1,
    text_en: "", text_zh: null, latex: null, img_url: null,
    caption: null, anchor: "b1", translate: true, ...p,
  };
}

const toc: SectionNode[] = [
  { id: "S1", title: "Introduction", level: 1, children: [
    { id: "S1.1", title: "Motivation", level: 2, children: [] },
  ] },
  { id: "S2", title: "Method", level: 1, children: [] },
];

function mkPaper(blocks: Block[], over: Partial<ParsedPaper> = {}): ParsedPaper {
  return {
    source_url: "https://arxiv.org/abs/test", source_type: "arxiv", arxiv_id: "test",
    title: "Attention Is All You Need", abstract: "We propose the Transformer.", toc,
    blocks,
    meta: { parser: "test", block_count: blocks.length, parsed_at: Date.now() },
    ...over,
  };
}

// 计数型 mock gateway：每次返回固定 markmap，记录调用次数。
function mockGateway(): { cfg: GatewayConfig; calls: () => number; lastBody: () => any } {
  let n = 0;
  let last: any = null;
  const fetchImpl = (async (_url: string, init: any) => {
    n++;
    last = JSON.parse(init.body);
    const content = "# Root\n## Section\n- point one\n- point two [S2]";
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200, headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return {
    cfg: { baseUrl: "https://gw.test", token: "t", fetchImpl, maxRetries: 0 },
    calls: () => n,
    lastBody: () => last,
  };
}

async function main() {
  console.log("=== F4 mindmap: pure helpers ===");
  const outline = tocOutline(toc);
  check("tocOutline includes nested section with indent", outline.includes("[S1.1]") && /\n\s+- \[S1\.1\]/.test(outline), outline);
  check("tocOutline top-level both sections", outline.includes("[S1]") && outline.includes("[S2]"));

  const blocks = [
    mkBlock({ id: "p1", sec: "S1", type: "para", text_en: "Intro english.", text_zh: "引言中文。" }),
    mkBlock({ id: "p2", sec: "S1", type: "para", text_en: "Second intro para." }),
    mkBlock({ id: "h1", sec: "S2", type: "heading", text_en: "Method heading" }),
    mkBlock({ id: "p3", sec: "S2", type: "para", text_en: "Method english." }),
  ];
  const essZh = sectionEssence(blocks, "zh");
  check("sectionEssence zh prefers text_zh", essZh.includes("引言中文"), essZh);
  check("sectionEssence one snippet per section (S1 first para only)", (essZh.match(/\[S1\]/g) || []).length === 1, essZh);
  check("sectionEssence skips heading-only, uses S2 para", essZh.includes("Method english"), essZh);
  const essEn = sectionEssence(blocks, "en");
  check("sectionEssence en uses text_en", essEn.includes("Intro english"), essEn);

  const prompt = buildMindmapPrompt(mkPaper(blocks), "zh");
  check("prompt system asks markmap markdown", prompt.system.includes("markmap"));
  check("prompt user injects title", prompt.user.includes("Attention Is All You Need"));
  check("prompt user injects abstract", prompt.user.includes("Transformer"));
  check("prompt user injects toc outline", prompt.user.includes("[S1]"));

  console.log("=== F4 mindmap: stripCodeFence ===");
  check("strips ```markdown fence", stripCodeFence("```markdown\n# A\n- b\n```") === "# A\n- b");
  check("strips plain ``` fence", stripCodeFence("```\n# A\n```") === "# A");
  check("passes through bare md", stripCodeFence("# A\n- b") === "# A\n- b");

  console.log("=== F4 mindmap: generateMindmap (mock gateway) ===");
  {
    const gw = mockGateway();
    const out = await generateMindmap({ gateway: gw.cfg }, mkPaper(blocks), "zh");
    check("returns markmap_md", out.markmap_md.startsWith("# Root"));
    check("model defaults MINDMAP_MODEL", out.model === MINDMAP_MODEL);
    // 模型规范守卫：MINDMAP_MODEL=qwen3.7-plus + max_tokens 降到 1200（控超时）。
    check(" MINDMAP_MODEL = qwen3.7-plus", MINDMAP_MODEL === "qwen3.7-plus", MINDMAP_MODEL);
    check(" MINDMAP_MAX_TOKENS = 1200", MINDMAP_MAX_TOKENS === 1200, MINDMAP_MAX_TOKENS);
    check("sends enable_thinking:false", gw.lastBody().enable_thinking === false);
    check("sends max_tokens (MINDMAP_MAX_TOKENS=1200)", gw.lastBody().max_tokens === MINDMAP_MAX_TOKENS);
  }
  {
    // 兜底：模型不给根节点 "# " 时补标题
    const noRoot = (async (_u: string, _i: any) =>
      new Response(JSON.stringify({ choices: [{ message: { content: "- only a point" } }] }), {
        status: 200, headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const out = await generateMindmap(
      { gateway: { baseUrl: "https://gw.test", token: "t", fetchImpl: noRoot, maxRetries: 0 } },
      mkPaper(blocks), "en",
    );
    check("injects root '# title' when model omits it", out.markmap_md.startsWith("# Attention Is All You Need"), out.markmap_md);
  }

  console.log("=== F4 mindmap: mindmapPaper cache + force + lang + 404 ===");
  {
    const db = memDb();
    const now = Date.now();
    await savePaper(db, "test", mkPaper(blocks));
    const gw = mockGateway();
    const ctx: ServiceCtx = {
      db, translate: { gateway: gw.cfg } as any,
      qa: { gateway: gw.cfg },
    };

    const r1 = await mindmapPaper(ctx, "test", { lang: "zh" });
    check("first call generates (cached:false)", !!r1 && r1.cached === false, r1);
    check("LLM called once", gw.calls() === 1);

    const r2 = await mindmapPaper(ctx, "test", { lang: "zh" });
    check("second call hits cache (cached:true)", !!r2 && r2.cached === true, r2);
    check("LLM not called again", gw.calls() === 1);

    const r3 = await mindmapPaper(ctx, "test", { lang: "zh", force: true });
    check("force regenerates (cached:false)", !!r3 && r3.cached === false, r3);
    check("LLM called again on force", gw.calls() === 2);

    const rEn = await mindmapPaper(ctx, "test", { lang: "en" });
    check("en is separate cache (cached:false)", !!rEn && rEn.cached === false, rEn);
    check("LLM called for en", gw.calls() === 3);
    const zhRow = await getMindmap(db, "test", "zh");
    const enRow = await getMindmap(db, "test", "en");
    check("zh + en rows coexist", !!zhRow && !!enRow && zhRow.lang === "zh" && enRow.lang === "en");

    const r404 = await mindmapPaper(ctx, "missing-paper", { lang: "zh" });
    check("missing paper returns null (→404)", r404 === null);

    // 空论文（无 blocks）仍能生成（toc/essence 退化为空，prompt 兜底）
    await savePaper(db, "empty", mkPaper([], { toc: [], abstract: null, title: "Empty" }));
    const rEmpty = await mindmapPaper(ctx, "empty", { lang: "zh" });
    check("empty paper still produces a mindmap", !!rEmpty && rEmpty.markmap_md.length > 0, rEmpty);
  }

  console.log(fail === 0 ? "\nF4 MINDMAP: ALL PASS ✅" : `\nF4 MINDMAP: ${fail} FAILED ❌`);
  if (fail > 0) process.exit(1);
}

main();
