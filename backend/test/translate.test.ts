// M2 单测：公式保护 mask/unmask + 降级分段 + 翻译引擎（mock gateway）+ D1 缓存 + 对照视图。
// 跑法：npx tsx test/translate.test.ts
// 核心验收：公式不坏（math/figure 不送翻；行内公式 mask 还原；MT 丢哨兵自动降级保公式）。

import {
  maskInlineMath,
  unmaskInlineMath,
  translateBySplit,
} from "../src/translate/mask.js";
import { translateBlock, type TranslateConfig } from "../src/translate/engine.js";
import { chatCompletion, GatewayError, type GatewayConfig } from "../src/llm/gateway.js";
import type { Block } from "../src/parse/types.js";
import {
  savePaper,
  getPaperBlocks,
  getTranslations,
  putTranslation,
  type D1Like,
} from "../src/store/d1.js";
import { translatePaper, type ServiceCtx } from "../src/service.js";
import { resolveLlmFetch } from "../src/index.js";
import { buildBilingualView } from "../src/render/bilingual.js";
import type { ParsedPaper } from "../src/parse/types.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

function mkBlock(p: Partial<Block>): Block {
  return {
    id: "b1",
    type: "para",
    sec: "S1",
    order: 0,
    level: 1,
    text_en: "",
    text_zh: null,
    latex: null,
    img_url: null,
    caption: null,
    anchor: "b1",
    translate: true,
    ...p,
  };
}

async function main() {
  // ---- 1. mask / unmask ----
  console.log("\n=== mask/unmask 公式保护 ===");
  {
    const src = "The attention $A=QK^T$ scales by $\\sqrt{d}$ here.";
    const { masked, formulas, hasMath } = maskInlineMath(src);
    check("检出公式", hasMath && formulas.length === 2, formulas);
    check("masked 无 $", !masked.includes("$"), masked);
    check("masked 含哨兵", /⟦F0⟧/.test(masked) && /⟦F1⟧/.test(masked), masked);

    const mt = "注意力 ⟦F0⟧ 在此处按 ⟦F1⟧ 缩放。";
    const { text, ok } = unmaskInlineMath(mt, formulas);
    check("哨兵全还原 ok", ok, text);
    check("公式原样回填", text.includes("$A=QK^T$") && text.includes("$\\sqrt{d}$"), text);
  }

  // ---- 2. unmask 缺哨兵 → ok=false ----
  {
    const { formulas } = maskInlineMath("a $x$ b $y$ c");
    const broken = unmaskInlineMath("译文只剩 ⟦F0⟧ 一个", formulas);
    check("丢哨兵 → ok=false", !broken.ok, broken.found);
  }

  // ---- 3. translateBySplit 降级：公式 100% 不坏 ----
  console.log("\n=== translateBySplit 降级 ===");
  {
    const src = "Given $E=mc^2$, energy follows $F=ma$ exactly.";
    const out = await translateBySplit(src, async (prose) => `[zh:${prose.trim()}]`);
    check("公式 1 保留", out.includes("$E=mc^2$"), out);
    check("公式 2 保留", out.includes("$F=ma$"), out);
    check("散文被翻", out.includes("[zh:"), out);
    check("公式未进翻译fn", !out.includes("[zh:$"), out);
  }

  // ---- 4. translateBlock：translate=false 跳过 ----
  console.log("\n=== translateBlock ===");
  {
    const mathB = mkBlock({ id: "m1", type: "math", text_en: "", latex: "A=QK^T", translate: false });
    const figB = mkBlock({ id: "f1", type: "figure", text_en: "Fig 1", img_url: "x.png", translate: false });
    const cfg: TranslateConfig = {
      gateway: { baseUrl: "http://mock", token: "t", fetchImpl: mockFetch("不该被调用") },
    };
    const r1 = await translateBlock(mathB, cfg);
    const r2 = await translateBlock(figB, cfg);
    check("math 不送翻 → null", r1 === null);
    check("figure 不送翻 → null", r2 === null);
  }

  // ---- 5. translateBlock：纯文本段调 gateway ----
  {
    const b = mkBlock({ id: "p1", text_en: "Hello world." });
    const cfg: TranslateConfig = {
      gateway: { baseUrl: "http://mock", token: "t", fetchImpl: mockFetch("你好世界。") },
    };
    const r = await translateBlock(b, cfg);
    check("para 翻译命中 gateway", r?.text_zh === "你好世界。", r);
    check("degraded=false", r?.degraded === false);
  }

  // ---- 6. translateBlock：含公式，MT 保留哨兵 ----
  {
    const b = mkBlock({ id: "p2", text_en: "Scale by $\\sqrt{d}$ value." });
    const cfg: TranslateConfig = {
      gateway: {
        baseUrl: "http://mock",
        token: "t",
        fetchImpl: mockFetchEcho((sent) => `按 ${sent.match(/⟦F0⟧/)?.[0]} 缩放该值。`),
      },
    };
    const r = await translateBlock(b, cfg);
    check("含公式翻译保留 latex", !!r && r.text_zh.includes("$\\sqrt{d}$"), r);
    check("非降级（哨兵完整）", r?.degraded === false, r);
  }

  // ---- 7. translateBlock：MT 丢哨兵 → 自动降级 ----
  {
    const b = mkBlock({ id: "p3", text_en: "Use $x$ and $y$ now." });
    let call = 0;
    const cfg: TranslateConfig = {
      gateway: {
        baseUrl: "http://mock",
        token: "t",
        fetchImpl: mockFetchEcho((sent) => {
          call++;
          if (call === 1) return "丢了哨兵的译文";
          return `[${sent.trim()}]`;
        }),
      },
    };
    const r = await translateBlock(b, cfg);
    check("降级路径触发 degraded=true", r?.degraded === true, r);
    check("降级后公式仍在", !!r && r.text_zh.includes("$x$") && r.text_zh.includes("$y$"), r);
  }

  // ---- 8. D1 内存 mock：落地 + 缓存读写 ----
  console.log("\n=== D1 store ===");
  {
    const db = memStore();
    const paper = mkPaper();
    await savePaper(db, "1706.03762v7", paper);
    const got = await getPaperBlocks(db, "1706.03762v7");
    check("D1 blocks 往返一致", got?.blocks.length === paper.blocks.length, got?.blocks.length);

    await putTranslation(db, "1706.03762v7", {
      block_id: "p1",
      text_zh: "你好",
      model: "qwen-mt-turbo",
      degraded: false,
    });
    const trans = await getTranslations(db, "1706.03762v7");
    check("翻译缓存命中", trans.get("p1")?.text_zh === "你好", [...trans]);

    const subset = await getTranslations(db, "1706.03762v7", ["p1", "nope"]);
    check("子集查询只返存在的", subset.size === 1 && subset.has("p1"), [...subset]);

    // 回归：blockIds >99 时 D1 100 参数上限，getTranslations 必须分批不崩。
    {
      const bigDb = memStore();
      const N = 250; // 跨 80-chunk 多次边界（50-150 block 论文的上界场景）
      const ids: string[] = [];
      for (let i = 0; i < N; i++) {
        const bid = `blk${i}`;
        ids.push(bid);
        await putTranslation(bigDb, "big", {
          block_id: bid,
          text_zh: `zh${i}`,
          model: "qwen-mt-turbo",
          degraded: false,
        });
      }
      const all = await getTranslations(bigDb, "big", ids);
      check("⚠ >99 block_id 分批查全部命中", all.size === N, all.size);
      check("⚠ 分批后首尾 block 都在", all.get("blk0")?.text_zh === "zh0" && all.get(`blk${N - 1}`)?.text_zh === `zh${N - 1}`, [all.get("blk0"), all.get(`blk${N - 1}`)]);
    }
  }

  // ---- 9. buildBilingualView：公式不掺中文，pending/done 统计 ----
  console.log("\n=== bilingual view ===");
  {
    const paper = mkPaper();
    const trans = new Map([
      ["p1", { block_id: "p1", text_zh: "段一中文", model: "m", degraded: false }],
    ]);
    const view = buildBilingualView("pid", paper, trans);
    const mathBlk = view.blocks.find((b) => b.type === "math")!;
    check("math 块 text_zh=null", mathBlk.text_zh === null, mathBlk);
    check("math zh_status=none", mathBlk.zh_status === "none");
    check("已翻 block done", view.blocks.find((b) => b.id === "p1")?.zh_status === "done");
    check("未翻可翻 block pending", view.blocks.find((b) => b.id === "p2")?.zh_status === "pending");
    check("stats.translated=1", view.stats.translated === 1, view.stats);
    check("stats.translatable=2", view.stats.translatable === 2, view.stats);
  }

  // ---- 10. translatePaper fan-out 限流：F3-fix2 单次 ≤8（实测后定，防 CPU/duration 墙）----
  console.log("\n=== translatePaper fan-out cap (F3-fix2 →8) ===");
  {
    // 20 个可翻 para，单次应只翻 8，剩 12
    const blocks: Block[] = Array.from({ length: 20 }, (_, i) =>
      mkBlock({ id: `fb${i}`, type: "para", text_en: `Para ${i}.`, translate: true }),
    );
    const paper: ParsedPaper = {
      source_url: "x", source_type: "arxiv", arxiv_id: "cap-test",
      title: "cap", abstract: "", toc: [], blocks,
      meta: { parser: "test", block_count: 20, parsed_at: 0 },
    };
    const db = memStore();
    await savePaper(db, "cap-test", paper);
    const ctx: ServiceCtx = {
      db,
      translate: { gateway: { baseUrl: "http://mock", token: "t", fetchImpl: mockFetch("译文") } },
    };
    const r1 = await translatePaper(ctx, "cap-test");
    check("单次最多翻 8", r1?.translated.length === 8, r1?.translated.length);
    check("remaining=12", r1?.remaining === 12, r1?.remaining);
    check("has_more=true", r1?.has_more === true, r1?.has_more);
    // 第二次：再翻 8，剩 4（验幂等 + 已翻走缓存）
    const r2 = await translatePaper(ctx, "cap-test");
    check("第二次再翻 8", r2?.translated.length === 8, r2?.translated.length);
    check("第二次 cached_hit=8（已翻不重复，幂等）", r2?.cached_hit === 8, r2?.cached_hit);
    check("第二次 remaining=4", r2?.remaining === 4, r2?.remaining);
    // 第三次：剩 4 翻完
    const r3 = await translatePaper(ctx, "cap-test");
    check("第三次翻完剩 4", r3?.translated.length === 4, r3?.translated.length);
    check("has_more=false", r3?.has_more === false, r3?.has_more);
  }

  // ---- 11. service binding：present→走 binding.fetch；absent→fallback ----
  console.log("\n=== resolveLlmFetch service binding ===");
  {
    // binding 缺失 → undefined（gateway 自动 fallback 到全局 fetch(public URL)）
    check("binding absent → undefined", resolveLlmFetch(undefined) === undefined);

    // binding present → 返回的 fetch 实际转调 binding.fetch（不碰 public edge）
    let called = 0;
    let sawUrl = "";
    let sawAuth = "";
    const fakeBinding = {
      fetch: (input: any, _init?: any) => {
        called++;
        sawUrl = typeof input === "string" ? input : input?.url ?? "";
        // 回归：binding.fetch 收到的必须是 Request 且 Authorization header 在其上
        sawAuth =
          input instanceof Request ? input.headers.get("authorization") ?? "" : "";
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "绑定译文" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    } as unknown as Fetcher;
    const bound = resolveLlmFetch(fakeBinding);
    check("binding present → 返回 fetch 函数", typeof bound === "function");
    const res = await bound!("https://api-llm.example.com/v1/chat/completions", {
      method: "POST",
      headers: { authorization: "Bearer test-research-token" },
    });
    const body = await res.json();
    check("调用走 binding.fetch", called === 1, called);
    check("URL 原样转发（host 保留，path 一致）", sawUrl.endsWith("/v1/chat/completions"), sawUrl);
    check("⚠ Authorization header 透传给 binding", sawAuth === "Bearer test-research-token", sawAuth);
    check("binding 响应正常解析", (body as any).choices[0].message.content === "绑定译文");
  }

  // ---- 12. : gateway 429 重试（Retry-After 优先 + 指数退避） ----
  console.log("\n=== gateway 429 retry ===");
  {
    // 12a: 429 两次后 200 → withRetry 自动重试成功，sleep 被注入（无真延时）。
    let calls = 0;
    const sleeps: number[] = [];
    const cfg: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      sleepImpl: async (ms) => {
        sleeps.push(ms);
      },
      fetchImpl: (async () => {
        calls++;
        if (calls <= 2) {
          return new Response("rate limited", {
            status: 429,
            headers: { "retry-after": "2" },
          });
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "重试后成功" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any,
    };
    const out = await chatCompletion(cfg, {
      model: "qwen-mt-turbo",
      messages: [{ role: "user", content: "hi" }],
    });
    check("⚠ 429x2 后重试成功", out === "重试后成功", out);
    check("⚠ 实际请求 3 次（2 retry）", calls === 3, calls);
    check("⚠ sleep 调 2 次", sleeps.length === 2, sleeps);
    check("⚠ Retry-After=2s 被尊重（每次 ≥2000ms）", sleeps.every((s) => s >= 2000), sleeps);
  }

  // 12b: 非 429（400）→ 不重试，立即抛。
  {
    let calls = 0;
    const cfg: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("bad request", { status: 400 });
      }) as any,
    };
    let threw: GatewayError | null = null;
    try {
      await chatCompletion(cfg, { model: "m", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      threw = e as GatewayError;
    }
    check("⚠ 400 不重试（仅 1 次）", calls === 1, calls);
    check("⚠ 400 抛 GatewayError retryable=false", !!threw && threw.retryable === false, threw?.status);
  }

  // 12c: 持续 429 直到耗尽 maxRetries → 抛 rate_limited，rateLimited=true。
  {
    let calls = 0;
    const cfg: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      maxRetries: 2,
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls++;
        return new Response("nope", { status: 429 });
      }) as any,
    };
    let threw: GatewayError | null = null;
    try {
      await chatCompletion(cfg, { model: "m", messages: [{ role: "user", content: "x" }] });
    } catch (e) {
      threw = e as GatewayError;
    }
    check("⚠ 持续 429 耗尽 maxRetries=2 → 共 3 次", calls === 3, calls);
    check("⚠ 终抛 rateLimited=true code=rate_limited", !!threw && threw.rateLimited === true && threw.code === "rate_limited", [threw?.code, threw?.rateLimited]);
  }

  // 12d: 5xx 也重试（视为 upstream 瞬断）。
  {
    let calls = 0;
    const cfg: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      sleepImpl: async () => {},
      fetchImpl: (async () => {
        calls++;
        if (calls === 1) return new Response("boom", { status: 503 });
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "503后恢复" } }] }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }) as any,
    };
    const out = await chatCompletion(cfg, { model: "m", messages: [{ role: "user", content: "x" }] });
    check("⚠ 503 重试后成功", out === "503后恢复" && calls === 2, [out, calls]);
  }

  // ---- 13. : translatePaper partial-fail 容错 + 并发降级 ----
  console.log("\n=== translatePaper partial-fail + 并发降级 ===");
  {
    // 5 个可翻 block，其中 bad2 段始终 429（耗尽重试仍败）；其余成功。
    // 期望：4 个成功并落缓存，bad2 进 failed，整批不崩。
    const blocks: Block[] = ["ok0", "ok1", "bad2", "ok3", "ok4"].map((id, i) =>
      mkBlock({ id, type: "para", order: i, text_en: `Text of ${id}.`, translate: true }),
    );
    const paper: ParsedPaper = {
      source_url: "x", source_type: "arxiv", arxiv_id: "pf-test",
      title: "pf", abstract: "", toc: [], blocks,
      meta: { parser: "test", block_count: blocks.length, parsed_at: 0 },
    };
    const db = memStore();
    await savePaper(db, "pf-test", paper);
    // mock fetch：body 含 "bad2" → 永久 429；否则 200 回译文。
    const fetchImpl = (async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const sent = body.messages[0].content as string;
      if (sent.includes("bad2")) {
        return new Response("429", { status: 429 });
      }
      return new Response(
        JSON.stringify({ choices: [{ message: { content: `zh:${sent}` } }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as any;
    const ctx: ServiceCtx = {
      db,
      translate: {
        gateway: { baseUrl: "http://mock", token: "t", fetchImpl, maxRetries: 2, sleepImpl: async () => {} },
      },
    };
    const r = await translatePaper(ctx, "pf-test", { concurrency: 4 });
    check("⚠ 单 block 失败不抛、整批返回", !!r, r);
    check("⚠ 4 个成功翻译", r?.translated.length === 4, r?.translated.length);
    check("⚠ failed=[bad2]", r?.failed.length === 1 && r?.failed[0] === "bad2", r?.failed);
    check("⚠ 成功 block 已落缓存", (await getTranslations(db, "pf-test")).size === 4, (await getTranslations(db, "pf-test")).size);
    check("⚠ bad2 未落缓存（留待重试）", !(await getTranslations(db, "pf-test")).has("bad2"));
    check("⚠ 成功译文保序正确", r?.translated[0].block_id === "ok0" && r?.translated[3].block_id === "ok4", r?.translated.map((t) => t.block_id));
  }

  {
    // 全 429：每个 block 都失败 → translated=0, failed=all，仍不抛。
    const blocks: Block[] = Array.from({ length: 6 }, (_, i) =>
      mkBlock({ id: `z${i}`, type: "para", order: i, text_en: `Z ${i}.`, translate: true }),
    );
    const paper: ParsedPaper = {
      source_url: "x", source_type: "arxiv", arxiv_id: "all-fail",
      title: "af", abstract: "", toc: [], blocks,
      meta: { parser: "test", block_count: 6, parsed_at: 0 },
    };
    const db = memStore();
    await savePaper(db, "all-fail", paper);
    const ctx: ServiceCtx = {
      db,
      translate: {
        gateway: {
          baseUrl: "http://mock", token: "t", maxRetries: 1, sleepImpl: async () => {},
          fetchImpl: (async () => new Response("429", { status: 429 })) as any,
        },
      },
    };
    const r = await translatePaper(ctx, "all-fail", { concurrency: 4 });
    check("⚠ 全失败 translated=0", r?.translated.length === 0, r?.translated.length);
    check("⚠ 全失败 failed=6", r?.failed.length === 6, r?.failed.length);
    check("⚠ 全失败仍正常返回（不抛）", r !== null);
  }

  // ---- 13. 迁移#7: x-llm-usecase header 透传（含 Service Binding） ----
  console.log("\n=== x-llm-usecase passthrough ===");
  {
    // 13a: chatCompletion 传 usecase → x-llm-usecase header 发出，且 body 不含 usecase（走 header 不污染上游）。
    let sawUsecase: string | undefined;
    let sawBody = "";
    const cfgWith: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      fetchImpl: (async (_url: any, init: any) => {
        sawUsecase = init?.headers?.["x-llm-usecase"];
        sawBody = init?.body ?? "";
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as any,
    };
    await chatCompletion(cfgWith, { model: "qwen3.7-plus", messages: [{ role: "user", content: "hi" }] }, "translate");
    check("chatCompletion 传 usecase → x-llm-usecase=translate", sawUsecase === "translate", sawUsecase);
    check("usecase 走 header 不进 body（body 无 usecase 字段）", !sawBody.includes("usecase"), sawBody.slice(0, 80));

    // 13b: 不传 usecase → header 缺省（零逻辑改动，老调用不受影响）。
    let sawUsecase2: string | undefined = "SENTINEL";
    const cfgWithout: GatewayConfig = {
      baseUrl: "http://mock",
      token: "t",
      fetchImpl: (async (_url: any, init: any) => {
        sawUsecase2 = init?.headers?.["x-llm-usecase"];
        return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as any,
    };
    await chatCompletion(cfgWithout, { model: "m", messages: [{ role: "user", content: "hi" }] });
    check("不传 usecase → x-llm-usecase header 缺省", sawUsecase2 === undefined, sawUsecase2);

    // 13c: ⚠ Service Binding 路径 — usecase + Authorization 经 Request 包装都不被吞（ 同款坑回归）。
    let bSawUsecase = "";
    let bSawAuth = "";
    const fakeBinding = {
      fetch: (input: any) => {
        bSawUsecase = input instanceof Request ? input.headers.get("x-llm-usecase") ?? "" : "";
        bSawAuth = input instanceof Request ? input.headers.get("authorization") ?? "" : "";
        return Promise.resolve(
          new Response(JSON.stringify({ choices: [{ message: { content: "绑定" } }] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
        );
      },
    } as unknown as Fetcher;
    const boundFetch = resolveLlmFetch(fakeBinding);
    const cfgBinding: GatewayConfig = {
      baseUrl: "https://api-llm.example.com",
      token: "test-research-token",
      fetchImpl: boundFetch,
    };
    await chatCompletion(cfgBinding, { model: "m", messages: [{ role: "user", content: "hi" }] }, "qa");
    check("⚠ Service Binding: x-llm-usecase 透传不被吞", bSawUsecase === "qa", bSawUsecase);
    check("⚠ Service Binding: Authorization 同时透传（ 回归）", bSawAuth === "Bearer test-research-token", bSawAuth);
  }

  console.log(fail === 0 ? "\nALL M2 TESTS PASS ✅" : `\n${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

// ---------- helpers ----------
function mockFetch(content: string): typeof fetch {
  return (async () =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })) as any;
}
function mockFetchEcho(fn: (sentContent: string) => string): typeof fetch {
  return (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    const sent = body.messages[0].content as string;
    return new Response(
      JSON.stringify({ choices: [{ message: { content: fn(sent) } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as any;
}

function mkPaper(): ParsedPaper {
  return {
    source_url: "https://arxiv.org/abs/1706.03762",
    source_type: "arxiv",
    arxiv_id: "1706.03762v7",
    title: "Attention Is All You Need",
    abstract: "abstract text",
    toc: [{ id: "S1", title: "Intro", level: 1, children: [] }],
    blocks: [
      mkBlock({ id: "p1", type: "para", text_en: "Para one.", translate: true }),
      mkBlock({ id: "p2", type: "para", text_en: "Para two with $x$.", translate: true }),
      mkBlock({ id: "m1", type: "math", text_en: "", latex: "A=QK^T", translate: false }),
      mkBlock({ id: "f1", type: "figure", text_en: "Fig", img_url: "x.png", translate: false }),
    ],
    meta: { parser: "test", block_count: 4, parsed_at: 0 },
  };
}

/** 极简内存 D1，覆盖本期用到的 SQL 形状。 */
function memStore(): D1Like {
  const papers = new Map<string, any>();
  const translations = new Map<string, any>();

  const db: D1Like = {
    prepare(q: string) {
      const stmt: any = {
        _q: q,
        _b: [] as unknown[],
        bind(...v: unknown[]) {
          this._b = v;
          return this;
        },
        async first<T>() {
          if (/FROM papers WHERE id/.test(q)) {
            const row = papers.get(this._b[0] as string) ?? null;
            if (row && /SELECT blocks_json/.test(q)) return ({ blocks_json: row.blocks_json } as unknown) as T;
            return row as T;
          }
          return null;
        },
        async run() {
          if (/INSERT INTO papers/.test(q)) {
            const [id, source_url, source_type, title, arxiv_id, block_count, blocks_json, now] = this._b;
            papers.set(id as string, {
              id, source_url, source_type, title, arxiv_id,
              status: "parsed", block_count, blocks_json,
              created_at: now, updated_at: now,
            });
          } else if (/INSERT INTO translations/.test(q)) {
            const [pid, bid, zh, model, degraded] = this._b;
            translations.set(`${pid}|${bid}`, {
              block_id: bid, text_zh: zh, model, degraded,
            });
          }
          return {};
        },
        async all<T>() {
          if (/FROM translations/.test(q)) {
            const pid = this._b[0] as string;
            let rows = [...translations.entries()]
              .filter(([k]) => k.startsWith(pid + "|"))
              .map(([, v]) => v);
            if (/block_id IN/.test(q)) {
              const ids = this._b.slice(1) as string[];
              rows = rows.filter((r) => ids.includes(r.block_id));
            }
            return { results: rows as T[] };
          }
          return { results: [] as T[] };
        },
      };
      return stmt;
    },
  };

  return db;
}

main();
