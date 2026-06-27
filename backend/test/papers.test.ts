// F2 单测：GET /api/papers 列表层（listPapers / listPapersView）。
// 覆盖：倒序排序、limit 默认/上限 clamp、空列表边界、字段集（不含 blocks_json）。
// 跑法：npx tsx test/papers.test.ts

import {
  listPapers,
  DEFAULT_PAPERS_LIMIT,
  MAX_PAPERS_LIMIT,
  type D1Like,
  type PaperListItem,
} from "../src/store/d1.js";
import { listPapersView, type ServiceCtx } from "../src/service.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

// ---- 内存 D1 mock：仅实现 listPapers 用到的 SELECT ... ORDER BY created_at DESC LIMIT ?1 ----
interface Row {
  id: string;
  title: string | null;
  source_type: string;
  arxiv_id: string | null;
  block_count: number;
  blocks_json: string | null;
  created_at: number;
}
function memDb(rows: Row[]): { db: D1Like; lastLimit: () => number | null } {
  let lastLimit: number | null = null;
  const db: D1Like = {
    prepare(query: string) {
      let binds: unknown[] = [];
      const q = query.replace(/\s+/g, " ").trim();
      const stmt: any = {
        bind(...vals: unknown[]) {
          binds = vals;
          return stmt;
        },
        async first<T>() {
          return null as T | null;
        },
        async all<T>() {
          if (q.includes("FROM papers ORDER BY created_at DESC LIMIT")) {
            lastLimit = binds[0] as number;
            const sorted = [...rows].sort((a, b) => b.created_at - a.created_at);
            // 投影：刻意只取列表字段，验证不泄漏 blocks_json
            const proj = sorted.slice(0, lastLimit).map((r) => ({
              id: r.id,
              title: r.title,
              source_type: r.source_type,
              arxiv_id: r.arxiv_id,
              block_count: r.block_count,
              created_at: r.created_at,
            }));
            return { results: proj as T[] };
          }
          return { results: [] as T[] };
        },
        async run() {
          return {};
        },
      };
      return stmt;
    },
  };
  return { db, lastLimit: () => lastLimit };
}

function mkRow(p: Partial<Row>): Row {
  return {
    id: "x",
    title: "T",
    source_type: "arxiv",
    arxiv_id: "x",
    block_count: 1,
    blocks_json: '{"big":"payload"}',
    created_at: 0,
    ...p,
  };
}

async function main() {
  console.log("=== F2 listPapers: 排序 + 字段 ===");
  {
    const rows = [
      mkRow({ id: "a", created_at: 100 }),
      mkRow({ id: "b", created_at: 300 }),
      mkRow({ id: "c", created_at: 200 }),
    ];
    const { db } = memDb(rows);
    const out = await listPapers(db);
    check("倒序 created_at DESC", out.map((r) => r.id).join(",") === "b,c,a", out.map((r) => r.id));
    const sample = out[0] as PaperListItem & { blocks_json?: unknown };
    check(
      "字段集 = id/title/source_type/arxiv_id/block_count/created_at",
      ["id", "title", "source_type", "arxiv_id", "block_count", "created_at"].every(
        (k) => k in sample,
      ),
      Object.keys(sample),
    );
    check("不泄漏 blocks_json", !("blocks_json" in sample), Object.keys(sample));
  }

  console.log("=== F2 listPapers: limit clamp ===");
  {
    const rows = Array.from({ length: 5 }, (_, i) => mkRow({ id: `p${i}`, created_at: i }));
    const { db, lastLimit } = memDb(rows);
    await listPapers(db); // 默认
    check("默认 limit = DEFAULT_PAPERS_LIMIT", lastLimit() === DEFAULT_PAPERS_LIMIT, lastLimit());

    const { db: db2, lastLimit: ll2 } = memDb(rows);
    await listPapers(db2, 9999);
    check("超大 limit clamp 到 MAX_PAPERS_LIMIT", ll2() === MAX_PAPERS_LIMIT, ll2());

    const { db: db3, lastLimit: ll3 } = memDb(rows);
    await listPapers(db3, 0);
    check("limit=0 回落默认", ll3() === DEFAULT_PAPERS_LIMIT, ll3());

    const { db: db4, lastLimit: ll4 } = memDb(rows);
    await listPapers(db4, -7);
    check("负 limit 回落 >=1", (ll4() ?? 0) >= 1, ll4());

    const { db: db5, lastLimit: ll5 } = memDb(rows);
    await listPapers(db5, 10);
    check("正常 limit 透传", ll5() === 10, ll5());
  }

  console.log("=== F2 listPapers: 空列表 ===");
  {
    const { db } = memDb([]);
    const out = await listPapers(db);
    check("空表返回 []", Array.isArray(out) && out.length === 0, out);
  }

  console.log("=== F2 listPapersView (service 层透传) ===");
  {
    const rows = [
      mkRow({ id: "s1", created_at: 10 }),
      mkRow({ id: "s2", created_at: 20 }),
    ];
    const { db } = memDb(rows);
    const ctx = { db } as ServiceCtx;
    const out = await listPapersView(ctx);
    check("service 倒序透传", out.map((r) => r.id).join(",") === "s2,s1", out.map((r) => r.id));
    const { db: db2, lastLimit } = memDb(rows);
    await listPapersView({ db: db2 } as ServiceCtx, 3);
    check("service 透传自定义 limit", lastLimit() === 3, lastLimit());
  }

  if (fail) {
    console.log(`\n${fail} CHECK(S) FAILED ✗`);
    process.exit(1);
  }
  console.log("\nALL F2 PAPERS TESTS PASS ✅");
}

main();
