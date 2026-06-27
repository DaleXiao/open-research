// 单测：client-parse import 契约（saveClientPaper）。
// worker 零解析零 fetch arxiv，只校验前端提交的 blocks + 落库。覆盖：
//   - 合法 payload → savePaper(ready) + 返回 paper
//   - 缓存命中（已有 blocks，非 force）→ cached=true，不重写
//   - force → 覆盖重写
//   - 校验失败：缺 paper_id / blocks 空 / block 缺 id / block id 重复 / type 非法 → ImportValidationError
// 跑法：npx tsx test/import-client.test.ts

import {
  saveClientPaper,
  ImportValidationError,
  type ClientPaperPayload,
  type ServiceCtx,
} from "../src/service.js";
import type { D1Like } from "../src/store/d1.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}`, info ?? ""); }
}

// 内存 D1 mock：papers 单表，支持 saveClientPaper 用到的 getPaperBlocks(SELECT blocks_json)
// + savePaper(INSERT ... ON CONFLICT)。
interface Row { id: string; blocks_json: string | null; status: string }
function memDb(): { db: D1Like; rows: Map<string, Row> } {
  const rows = new Map<string, Row>();
  const db: D1Like = {
    prepare(query: string) {
      let binds: unknown[] = [];
      const q = query.replace(/\s+/g, " ").trim();
      const stmt: any = {
        bind(...v: unknown[]) { binds = v; return stmt; },
        async first<T>() {
          if (q.startsWith("SELECT blocks_json FROM papers")) {
            const r = rows.get(binds[0] as string);
            return r ? ({ blocks_json: r.blocks_json } as T) : null;
          }
          return null;
        },
        async all<T>() { return { results: [] as T[] }; },
        async run() {
          // savePaper INSERT ... status='ready'
          if (q.includes("'ready'")) {
            const id = binds[0] as string;
            // binds: id, source_url, source_type, title, arxiv_id, block_count, blocks_json, now
            const blocks_json = binds[6] as string;
            rows.set(id, { id, blocks_json, status: "ready" });
          }
          return {};
        },
      };
      return stmt;
    },
  };
  return { db, rows };
}

function mkCtx(db: D1Like): ServiceCtx {
  return {
    db,
    translate: { gateway: { baseUrl: "http://mock", token: "t" }, model: "m", sourceLang: "English", targetLang: "Chinese" },
  };
}

function mkPayload(over: Partial<ClientPaperPayload> = {}): ClientPaperPayload {
  return {
    paper_id: "1706.03762v7",
    source_url: "https://arxiv.org/abs/1706.03762v7",
    source_type: "arxiv",
    arxiv_id: "1706.03762v7",
    title: "Attention Is All You Need",
    blocks: [
      { id: "abstract1", type: "para", sec: "abstract", order: 0, level: 1, text_en: "We propose...", text_zh: null, latex: null, img_url: null, caption: null, anchor: "abstract1", translate: true },
      { id: "S1.p1", type: "para", sec: "S1", order: 1, level: 1, text_en: "Intro...", text_zh: null, latex: null, img_url: null, caption: null, anchor: "S1.p1", translate: true },
    ],
    toc: [{ id: "S1", title: "Introduction", level: 1, children: [] }],
    ...over,
  };
}

async function expectInvalid(name: string, payload: any) {
  const { db } = memDb();
  let threw: unknown = null;
  try { await saveClientPaper(mkCtx(db), payload); } catch (e) { threw = e; }
  check(name, threw instanceof ImportValidationError, threw ? String((threw as any).message) : "未抛错");
}

async function main() {
  console.log("=== saveClientPaper 正常路径 ===");
  {
    const { db, rows } = memDb();
    const r = await saveClientPaper(mkCtx(db), mkPayload());
    check("合法 payload → cached=false", r.cached === false);
    check("落库 status=ready", rows.get("1706.03762v7")?.status === "ready");
    check("blocks 落库（2 块）", JSON.parse(rows.get("1706.03762v7")!.blocks_json!).blocks.length === 2);
    check("返回 paper.title", r.paper.title === "Attention Is All You Need");
    check("meta.parser=client-v1", r.paper.meta.parser === "client-v1");
  }

  console.log("\n=== 缓存语义 ===");
  {
    const { db } = memDb();
    const ctx = mkCtx(db);
    await saveClientPaper(ctx, mkPayload());
    // 第二次非 force → cached=true，不重写
    const r2 = await saveClientPaper(ctx, mkPayload({ title: "改了标题不该生效" }));
    check("已存在非 force → cached=true", r2.cached === true);
    check("缓存命中返回旧 blocks（title 不被覆盖）", r2.paper.title === "Attention Is All You Need", r2.paper.title);
    // force → 覆盖
    const r3 = await saveClientPaper(ctx, mkPayload({ title: "force 覆盖" }), { force: true });
    check("force → cached=false 重写", r3.cached === false && r3.paper.title === "force 覆盖");
  }

  console.log("\n=== 校验失败 → ImportValidationError ===");
  await expectInvalid("缺 paper_id", mkPayload({ paper_id: "" }));
  await expectInvalid("缺 source_url", mkPayload({ source_url: "" }));
  await expectInvalid("source_type 非法", mkPayload({ source_type: "html" as any }));
  await expectInvalid("blocks 非数组", mkPayload({ blocks: null as any }));
  await expectInvalid("blocks 空", mkPayload({ blocks: [] }));
  await expectInvalid("block 缺 id", mkPayload({ blocks: [{ ...mkPayload().blocks[0], id: "" }] }));
  await expectInvalid("block id 重复", mkPayload({ blocks: [mkPayload().blocks[0], mkPayload().blocks[0]] }));
  await expectInvalid("block type 非法", mkPayload({ blocks: [{ ...mkPayload().blocks[0], type: "bogus" as any }] }));

  console.log(fail === 0 ? "\nALL IMPORT-CLIENT TESTS PASS ✅" : `\n${fail} FAILED ❌`);
  process.exit(fail === 0 ? 0 : 1);
}

main();
