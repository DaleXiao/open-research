// M5 QA 单测：余弦检索 + prompt 拼接 + cited 解析 + embedding 懒生成 + askPaper（mock gateway）。
// 跑法：npx tsx test/qa.test.ts

import { cosineSim, topK } from "../src/qa/retrieve.js";
import {
  selectionContext,
  buildSelectionPrompt,
  buildFullPrompt,
  parseCited,
  backfillCited,
  QA_MODEL,
  RAG_TOP_K,
} from "../src/qa/engine.js";
import { embeddableBlocks, ensureEmbeddings, EMBED_MODEL } from "../src/qa/embed.js";
import { savePaper, getQaHistory, type D1Like } from "../src/store/d1.js";
import { askPaper, listQa, type ServiceCtx } from "../src/service.js";
import type { Block, ParsedPaper } from "../src/parse/types.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

// ---- 内存 D1 mock（复用 translate.test.ts 同款最小实现）----
function memDb(): D1Like {
  const tables: Record<string, any[]> = {
    papers: [],
    translations: [],
    embeddings: [],
    qa_history: [],
  };
  function run(query: string, binds: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("INSERT INTO papers")) {
      const [id, source_url, source_type, title, arxiv_id, block_count, blocks_json, created_at] =
        binds as any[];
      const existing = tables.papers.find((r) => r.id === id);
      const row = {
        id, source_url, source_type, title, arxiv_id, status: "parsed",
        block_count, blocks_json, created_at, updated_at: created_at,
      };
      if (existing) Object.assign(existing, row);
      else tables.papers.push(row);
      return;
    }
    if (q.startsWith("INSERT INTO embeddings")) {
      const [paper_id, block_id, vector_json, dim, model, created_at] = binds as any[];
      const ex = tables.embeddings.find((r) => r.paper_id === paper_id && r.block_id === block_id);
      const row = { paper_id, block_id, vector_json, dim, model, created_at };
      if (ex) Object.assign(ex, row);
      else tables.embeddings.push(row);
      return;
    }
    if (q.startsWith("INSERT INTO qa_history")) {
      const [id, paper_id, scope, question, answer, cited_block_ids, created_at] = binds as any[];
      tables.qa_history.push({ id, paper_id, scope, question, answer, cited_block_ids, created_at });
      return;
    }
  }
  function select(query: string, binds: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT blocks_json FROM papers")) {
      const row = tables.papers.find((r) => r.id === binds[0]);
      return row ? [{ blocks_json: row.blocks_json }] : [];
    }
    if (q.startsWith("SELECT * FROM papers")) {
      return tables.papers.filter((r) => r.id === binds[0]);
    }
    if (q.startsWith("SELECT block_id, vector_json, dim, model FROM embeddings")) {
      return tables.embeddings.filter((r) => r.paper_id === binds[0]);
    }
    if (q.includes("FROM qa_history")) {
      return tables.qa_history
        .filter((r) => r.paper_id === binds[0])
        .sort((a, b) => a.created_at - b.created_at);
    }
    if (q.startsWith("SELECT block_id, text_zh, model, degraded FROM translations")) {
      return [];
    }
    return [];
  }
  return {
    prepare(query: string) {
      let binds: unknown[] = [];
      const stmt: any = {
        bind(...vals: unknown[]) { binds = vals; return stmt; },
        async first<T>(_col?: string) {
          const rows = select(query, binds);
          return (rows[0] as T) ?? null;
        },
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

function mkPaper(blocks: Block[]): ParsedPaper {
  return {
    source_url: "https://arxiv.org/abs/test", source_type: "arxiv", arxiv_id: "test",
    title: "Test Paper", abstract: null, toc: [], blocks,
    meta: { parser: "test", block_count: blocks.length, parsed_at: Date.now() },
  };
}

async function main() {
  console.log("=== M5 QA: retrieve ===");
  check("cosineSim identical = 1", Math.abs(cosineSim([1, 2, 3], [1, 2, 3]) - 1) < 1e-9);
  check("cosineSim orthogonal = 0", Math.abs(cosineSim([1, 0], [0, 1])) < 1e-9);
  check("cosineSim zero vector = 0", cosineSim([0, 0], [1, 1]) === 0);
  {
    const cands = new Map<string, number[]>([
      ["a", [1, 0, 0]],
      ["b", [0.9, 0.1, 0]],
      ["c", [0, 1, 0]],
      ["d", [0, 0, 1]],
    ]);
    const hits = topK([1, 0, 0], cands, 2);
    check("topK returns k", hits.length === 2);
    check("topK ranks closest first", hits[0].block_id === "a" && hits[1].block_id === "b", hits);
  }

  console.log("=== M5 QA: engine prompt + cited ===");
  {
    const blocks = [
      mkBlock({ id: "p1", order: 0, text_en: "First." }),
      mkBlock({ id: "p2", order: 1, text_en: "Second selected." }),
      mkBlock({ id: "p3", order: 2, text_en: "Third." }),
      mkBlock({ id: "p4", order: 3, text_en: "Fourth." }),
    ];
    const ctx = selectionContext(blocks, "p2");
    check("selectionContext = selected + prev + next (3)", ctx.length === 3, ctx.map((b) => b.id));
    check("selectionContext includes selected", ctx.some((b) => b.id === "p2"));
    check("selectionContext includes neighbors p1,p3", ctx[0].id === "p1" && ctx[2].id === "p3");

    const sp = buildSelectionPrompt(ctx, "p2", "what?", "zh");
    check("selection prompt has selected id", sp.user.includes("p2"));
    check("selection prompt lang zh", sp.system.includes("中文"));
    check("selection contextBlockIds = 3", sp.contextBlockIds.length === 3);

    const fp = buildFullPrompt(blocks, "summary?", "en");
    check("full prompt lang en", fp.system.includes("English"));
    check("full prompt has block snippets", fp.user.includes("[p1]") && fp.user.includes("[p4]"));
  }
  {
    const { clean, cited } = parseCited("答案正文。\nCITED: p2, p3, ghost", ["p1", "p2", "p3"]);
    check("parseCited strips CITED line", !clean.includes("CITED"), clean);
    check("parseCited keeps valid ids", cited.includes("p2") && cited.includes("p3"));
    check("parseCited drops hallucinated id", !cited.includes("ghost"), cited);
  }
  {
    const { clean, cited } = parseCited("无引用答案", ["p1"]);
    check("parseCited no-CITED → empty cited", cited.length === 0 && clean === "无引用答案");
  }

  console.log("=== M5.1 QA: backfillCited (检索回填，不靠模型) ===");
  {
    // full: model 没吐 CITED → cited 仍非空 = top-k 检索集
    const bf1 = backfillCited(["a", "b", "c"], []);
    check("backfill empty model → full authoritative", bf1.length === 3 && bf1.join(",") === "a,b,c", bf1);
    // model 吐了且 ∈ authoritative → 置首高亮
    const bf2 = backfillCited(["a", "b", "c"], ["c"]);
    check("backfill model hit → hit first", bf2[0] === "c" && bf2.length === 3, bf2);
    // model 吐了幻觉 id ∉ authoritative → 丢弃
    const bf3 = backfillCited(["a", "b"], ["ghost", "b"]);
    check("backfill drops hallucinated, keeps valid first", bf3[0] === "b" && !bf3.includes("ghost") && bf3.length === 2, bf3);
    // 去重
    const bf4 = backfillCited(["a", "a", "b"], ["a"]);
    check("backfill dedups", bf4.length === 2 && bf4.join(",") === "a,b", bf4);
    // 空检索边界
    const bf5 = backfillCited([], ["x"]);
    check("backfill empty authoritative → empty", bf5.length === 0, bf5);
  }

  console.log("=== M5 QA: embeddable filter ===");
  {
    const blocks = [
      mkBlock({ id: "h1", type: "heading", text_en: "Intro" }),
      mkBlock({ id: "p1", type: "para", text_en: "text" }),
      mkBlock({ id: "m1", type: "math", text_en: "", latex: "x^2", translate: false }),
      mkBlock({ id: "f1", type: "figure", text_en: "", translate: false }),
      mkBlock({ id: "p2", type: "para", text_en: "   " }),
    ];
    const e = embeddableBlocks(blocks);
    check("embeddable = para+heading with text only", e.length === 2 && e.map((b) => b.id).sort().join(",") === "h1,p1", e.map((b) => b.id));
  }

  // ---- mock gateway fetch：embeddings + chat ----
  let embedCalls = 0;
  let chatCalls = 0;
  let lastChatBody: any = null;
  const mockFetch = (async (url: any, init?: any) => {
    const u = String(url);
    const body = JSON.parse(init.body);
    if (u.endsWith("/v1/embeddings")) {
      embedCalls++;
      const inputs: string[] = body.input;
      // 确定性假向量：按字符串长度 + 首字符 code
      const data = inputs.map((s, i) => ({
        index: i,
        embedding: [s.length, (s.charCodeAt(0) || 0) / 100, 1],
      }));
      return new Response(JSON.stringify({ data, model: body.model, usage: { prompt_tokens: 1, total_tokens: 1 } }), { status: 200 });
    }
    if (u.endsWith("/v1/chat/completions")) {
      chatCalls++;
      lastChatBody = body; // M5.3：捕获 chat body 验 enable_thinking/max_tokens
      // M5.1：模型故意不吐 CITED 标记（复现 live 行为）——验证 cited 从检索回填而非模型自报。
      const ans = body.messages[0].content.includes("English") ? "This is the answer." : "这是答案。";
      return new Response(JSON.stringify({
        choices: [{ message: { content: ans } }],
      }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;

  console.log("=== M5 QA: ensureEmbeddings lazy ===");
  {
    const db = memDb();
    const blocks = [
      mkBlock({ id: "p1", order: 0, text_en: "alpha" }),
      mkBlock({ id: "p2", order: 1, text_en: "beta gamma" }),
      mkBlock({ id: "m1", order: 2, type: "math", text_en: "", latex: "x", translate: false }),
    ];
    await savePaper(db, "test", mkPaper(blocks));
    const cfg = { gateway: { baseUrl: "https://gw", token: "t", fetchImpl: mockFetch }, model: EMBED_MODEL };
    embedCalls = 0;
    const r1 = await ensureEmbeddings(db, "test", blocks, cfg);
    check("first ensureEmbeddings lazyGenerated=true", r1.lazyGenerated === true);
    check("embeds only para+heading (2)", r1.vectors.size === 2, [...r1.vectors.keys()]);
    check("math block not embedded", !r1.vectors.has("m1"));
    const callsAfterFirst = embedCalls;
    const r2 = await ensureEmbeddings(db, "test", blocks, cfg);
    check("second ensureEmbeddings lazyGenerated=false (cache)", r2.lazyGenerated === false);
    check("no new embed calls on second", embedCalls === callsAfterFirst, { embedCalls, callsAfterFirst });
  }

  console.log("=== M5 QA: askPaper selection + full + history ===");
  {
    const db = memDb();
    const blocks = [
      mkBlock({ id: "p1", order: 0, text_en: "Attention mechanism intro." }),
      mkBlock({ id: "p2", order: 1, text_en: "The main contribution is the Transformer." }),
      mkBlock({ id: "p3", order: 2, text_en: "Experiments on translation." }),
    ];
    await savePaper(db, "test", mkPaper(blocks));
    const ctx: ServiceCtx = {
      db,
      translate: { gateway: { baseUrl: "https://gw", token: "t", fetchImpl: mockFetch } },
      qa: { gateway: { baseUrl: "https://gw", token: "t", fetchImpl: mockFetch } },
    };

    chatCalls = 0;
    const sel = await askPaper(ctx, "test", { scope: "selection", question: "主创新点？", lang: "zh", block_id: "p2" });
    check("selection 200 result", !!sel && sel.scope === "selection", sel);
    check("selection answer is zh", !!sel && /[\u4e00-\u9fa5]/.test(sel.answer), sel?.answer);
    // M5.1：模型不吐 CITED，cited 仍非空且含选中 block（检索回填）
    check("selection cited NON-EMPTY despite model silence", !!sel && sel.cited_block_ids.length > 0, sel?.cited_block_ids);
    check("selection cited includes selected p2", !!sel && sel.cited_block_ids.includes("p2"), sel?.cited_block_ids);
    check("selection cited ⊆ selection context (p1,p2,p3)", !!sel && sel.cited_block_ids.every((id) => ["p1", "p2", "p3"].includes(id)), sel?.cited_block_ids);
    check("selection model = QA_MODEL (qwen3.7-plus)", sel?.model === QA_MODEL, sel?.model);
    // 模型规范守卫：QA_MODEL 必须是合规的 qwen3.7-plus，不得回退杂牌。
    check(" QA_MODEL = qwen3.7-plus", QA_MODEL === "qwen3.7-plus", QA_MODEL);
    // M5.3 latency：chat body 携 enable_thinking:false + max_tokens 限（灭 reasoning 烧时）
    check("M5.3 chat body enable_thinking=false", lastChatBody?.enable_thinking === false, lastChatBody?.enable_thinking);
    check("M5.3 chat body max_tokens set", typeof lastChatBody?.max_tokens === "number" && lastChatBody.max_tokens > 0, lastChatBody?.max_tokens);

    const full = await askPaper(ctx, "test", { scope: "full", question: "what is the main idea?", lang: "en" });
    check("full 200 result", !!full && full.scope === "full");
    check("full answer is en", !!full && /[A-Za-z]/.test(full.answer) && !/[\u4e00-\u9fa5]/.test(full.answer), full?.answer);
    // M5.1：full cited 非空 = RAG top-k 命中段（模型不吐也有值）
    check("full cited NON-EMPTY despite model silence", !!full && full.cited_block_ids.length > 0, full?.cited_block_ids);
    check("full cited ⊆ paper blocks & ≤ top-k", !!full && full.cited_block_ids.every((id) => ["p1", "p2", "p3"].includes(id)) && full.cited_block_ids.length <= RAG_TOP_K);
    check("full embeddings_generated true first time", full?.embeddings_generated === true);

    const hist = await listQa(ctx, "test");
    check("history has 2 records", !!hist && hist.length === 2, hist?.length);
    check("history records carry cited", !!hist && hist[0].cited_block_ids.length > 0);

    const missing = await askPaper(ctx, "nope", { scope: "full", question: "x", lang: "zh" });
    check("askPaper unknown paper → null", missing === null);
  }

  console.log(fail === 0 ? "\nALL M5 QA TESTS PASS ✅" : `\n${fail} M5 QA TEST(S) FAILED ❌`);
  if (fail > 0) process.exit(1);
}

main();
