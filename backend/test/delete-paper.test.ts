// F5 单测：DELETE /api/paper/:id 级联删除（deletePaper / deletePaperView）。
// 覆盖：各表按 paper_id 清零 + papers 按 id 删 + 越权隔离（只删目标 paper）+ 404 不存在 + 删除计数。
// 跑法：npx tsx test/delete-paper.test.ts

import { deletePaper, type D1Like } from "../src/store/d1.js";
import { deletePaperView, type ServiceCtx } from "../src/service.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

// ---- 内存 D1 mock：papers + 派生表，支持 SELECT id / DELETE WHERE paper_id|id ----
interface Tables {
  papers: { id: string }[];
  translations: { paper_id: string; block_id: string }[];
  annotations: { id: string; paper_id: string }[];
  qa_history: { id: string; paper_id: string }[];
  embeddings: { paper_id: string; block_id: string }[];
  mindmaps: { paper_id: string; lang: string }[];
}

function memDb(seed: Tables): { db: D1Like; tables: Tables } {
  const tables = seed;
  const db: D1Like = {
    prepare(query: string) {
      let binds: unknown[] = [];
      const q = query.replace(/\s+/g, " ").trim();
      const stmt: any = {
        bind(...v: unknown[]) {
          binds = v;
          return stmt;
        },
        async first<T>() {
          if (q.startsWith("SELECT id FROM papers WHERE id=")) {
            const row = tables.papers.find((r) => r.id === binds[0]);
            return (row as T) ?? null;
          }
          return null;
        },
        async all<T>() {
          return { results: [] as T[] };
        },
        async run() {
          // DELETE FROM <t> WHERE paper_id=?1 / DELETE FROM papers WHERE id=?1
          const id = binds[0];
          let removed = 0;
          const delBy = (arr: any[], key: string) => {
            const before = arr.length;
            const kept = arr.filter((r) => r[key] !== id);
            removed = before - kept.length;
            return kept;
          };
          if (q.startsWith("DELETE FROM translations")) tables.translations = delBy(tables.translations, "paper_id");
          else if (q.startsWith("DELETE FROM annotations")) tables.annotations = delBy(tables.annotations, "paper_id");
          else if (q.startsWith("DELETE FROM qa_history")) tables.qa_history = delBy(tables.qa_history, "paper_id");
          else if (q.startsWith("DELETE FROM embeddings")) tables.embeddings = delBy(tables.embeddings, "paper_id");
          else if (q.startsWith("DELETE FROM mindmaps")) tables.mindmaps = delBy(tables.mindmaps, "paper_id");
          else if (q.startsWith("DELETE FROM papers")) tables.papers = delBy(tables.papers, "id");
          return { meta: { changes: removed } };
        },
      };
      return stmt;
    },
  };
  return { db, tables };
}

function seed(): Tables {
  return {
    papers: [{ id: "P1" }, { id: "P2" }],
    translations: [
      { paper_id: "P1", block_id: "b1" },
      { paper_id: "P1", block_id: "b2" },
      { paper_id: "P2", block_id: "b1" },
    ],
    annotations: [
      { id: "a1", paper_id: "P1" },
      { id: "a2", paper_id: "P2" },
    ],
    qa_history: [
      { id: "q1", paper_id: "P1" },
      { id: "q2", paper_id: "P1" },
      { id: "q3", paper_id: "P2" },
    ],
    embeddings: [
      { paper_id: "P1", block_id: "b1" },
      { paper_id: "P2", block_id: "b1" },
    ],
    mindmaps: [
      { paper_id: "P1", lang: "zh" },
      { paper_id: "P1", lang: "en" },
      { paper_id: "P2", lang: "zh" },
    ],
  };
}

async function main() {
  console.log("=== F5 deletePaper: 级联清各表 + 越权隔离 ===");
  {
    const { db, tables } = memDb(seed());
    const res = await deletePaper(db, "P1");
    check("返回非 null（存在）", !!res, res);
    check("papers 删 P1 留 P2", tables.papers.length === 1 && tables.papers[0].id === "P2", tables.papers);
    check("translations P1 清零，P2 保留", tables.translations.length === 1 && tables.translations[0].paper_id === "P2", tables.translations);
    check("annotations P1 清零，P2 保留", tables.annotations.length === 1 && tables.annotations[0].paper_id === "P2", tables.annotations);
    check("qa_history P1 清零，P2 保留", tables.qa_history.length === 1 && tables.qa_history[0].paper_id === "P2", tables.qa_history);
    check("embeddings P1 清零，P2 保留", tables.embeddings.length === 1 && tables.embeddings[0].paper_id === "P2", tables.embeddings);
    check("mindmaps P1(zh+en) 清零，P2 保留", tables.mindmaps.length === 1 && tables.mindmaps[0].paper_id === "P2", tables.mindmaps);
  }

  console.log("=== F5 deletePaper: 删除计数 ===");
  {
    const { db } = memDb(seed());
    const res = await deletePaper(db, "P1");
    check("translations 计数=2", res?.translations === 2, res);
    check("annotations 计数=1", res?.annotations === 1, res);
    check("qa_history 计数=2", res?.qa_history === 2, res);
    check("embeddings 计数=1", res?.embeddings === 1, res);
    check("mindmaps 计数=2", res?.mindmaps === 2, res);
    check("paper 计数=1", res?.paper === 1, res);
  }

  console.log("=== F5 deletePaper: 404 不存在 ===");
  {
    const { db, tables } = memDb(seed());
    const res = await deletePaper(db, "GHOST");
    check("不存在返回 null", res === null, res);
    check("其它数据未动", tables.papers.length === 2 && tables.translations.length === 3, tables);
  }

  console.log("=== F5 deletePaperView (service 透传) ===");
  {
    const { db, tables } = memDb(seed());
    const res = await deletePaperView({ db } as ServiceCtx, "P2");
    check("service 删 P2 留 P1", !!res && tables.papers.length === 1 && tables.papers[0].id === "P1", tables.papers);
    check("service P2 派生全清", tables.mindmaps.every((m) => m.paper_id !== "P2") && tables.qa_history.every((q) => q.paper_id !== "P2"));
  }

  if (fail) {
    console.log(`\n${fail} CHECK(S) FAILED ✗`);
    process.exit(1);
  }
  console.log("\nALL F5 DELETE TESTS PASS ✅");
}

main();
