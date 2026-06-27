// F1 单测：批注（划词笔记 + 锚定 + 书签）D1 存取层 + service 编排。
// 覆盖：putAnnotation/listAnnotations(ASC)/getAnnotation/updateAnnotation/deleteAnnotation；
//       createAnnotation（block 校验/note 空/过长/sel_start-end best-effort 降级/snapshot 截断）；
//       editAnnotation（not_found）/removeAnnotation（越权隔离）；paper 未导入 → null/false。
// 边界：跨 block 选区降级（sel 不传 → null）、重渲染重锚（block_id 不变）、空快照（quote_snapshot null）。
// 跑法：npx tsx test/annotations.test.ts

import {
  savePaper,
  listAnnotations,
  putAnnotation,
  getAnnotation,
  updateAnnotation,
  deleteAnnotation,
  type D1Like,
  type AnnotationRecord,
} from "../src/store/d1.js";
import {
  createAnnotation,
  listAnnotationsView,
  editAnnotation,
  removeAnnotation,
  AnnotationError,
  ANNOTATION_NOTE_MAX,
  ANNOTATION_SNAPSHOT_MAX,
  type ServiceCtx,
} from "../src/service.js";
import type { Block, ParsedPaper } from "../src/parse/types.js";

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}
async function expectThrow(name: string, fn: () => Promise<unknown>, code?: string) {
  try {
    await fn();
    fail++;
    console.log(`  ✗ ${name} (no throw)`);
  } catch (e) {
    if (code && (e as any)?.code !== code) {
      fail++;
      console.log(`  ✗ ${name} (code=${(e as any)?.code}, want ${code})`);
    } else {
      console.log(`  ✓ ${name}`);
    }
  }
}

// ---- 内存 D1 mock：覆盖 papers + annotations 的 SQL 形态 ----
function memDb(): D1Like {
  const tables: Record<string, any[]> = { papers: [], annotations: [] };
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
    if (q.startsWith("INSERT INTO annotations")) {
      const [id, paper_id, block_id, sel_start, sel_end, quote_snapshot, note_md, created_at] =
        binds as any[];
      const ex = tables.annotations.find((r) => r.id === id);
      const row = { id, paper_id, block_id, sel_start, sel_end, quote_snapshot, note_md, created_at };
      if (ex) Object.assign(ex, { block_id, sel_start, sel_end, quote_snapshot, note_md }); // ON CONFLICT(id) DO UPDATE
      else tables.annotations.push(row);
      return;
    }
    if (q.startsWith("UPDATE annotations SET note_md")) {
      const [annId, paperId, noteMd] = binds as any[];
      const r = tables.annotations.find((x) => x.id === annId && x.paper_id === paperId);
      if (r) r.note_md = noteMd;
      return;
    }
    if (q.startsWith("DELETE FROM annotations")) {
      const [annId, paperId] = binds as any[];
      const i = tables.annotations.findIndex((x) => x.id === annId && x.paper_id === paperId);
      if (i >= 0) tables.annotations.splice(i, 1);
      return;
    }
  }
  function select(query: string, binds: unknown[]) {
    const q = query.replace(/\s+/g, " ").trim();
    if (q.startsWith("SELECT blocks_json FROM papers")) {
      const row = tables.papers.find((r) => r.id === binds[0]);
      return row ? [{ blocks_json: row.blocks_json }] : [];
    }
    if (q.includes("FROM annotations WHERE paper_id=?1 ORDER BY created_at ASC")) {
      return tables.annotations
        .filter((r) => r.paper_id === binds[0])
        .sort((a, b) => a.created_at - b.created_at);
    }
    if (q.includes("FROM annotations WHERE id=?1 AND paper_id=?2")) {
      return tables.annotations.filter((r) => r.id === binds[0] && r.paper_id === binds[1]);
    }
    return [];
  }
  return {
    prepare(query: string) {
      let binds: unknown[] = [];
      const stmt: any = {
        bind(...vals: unknown[]) { binds = vals; return stmt; },
        async first<T>(_col?: string) { return (select(query, binds)[0] as T) ?? null; },
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
  console.log("=== F1 D1 层：put / list(ASC) / get / update / delete ===");
  {
    const db = memDb();
    const rec = (over: Partial<AnnotationRecord>): AnnotationRecord => ({
      id: "an1", paper_id: "P", block_id: "b1", sel_start: null, sel_end: null,
      quote_snapshot: null, note_md: "n", created_at: 0, ...over,
    });
    await putAnnotation(db, rec({ id: "an2", created_at: 200, note_md: "second" }));
    await putAnnotation(db, rec({ id: "an1", created_at: 100, note_md: "first" }));
    await putAnnotation(db, rec({ id: "an3", created_at: 300, note_md: "third" }));
    const list = await listAnnotations(db, "P");
    check("list 按 created_at ASC", list.map((r) => r.id).join(",") === "an1,an2,an3", list.map((r) => r.id));

    const one = await getAnnotation(db, "P", "an2");
    check("getAnnotation 命中", one?.note_md === "second", one);
    check("getAnnotation 越权 paper 返 null", (await getAnnotation(db, "OTHER", "an2")) === null);

    // upsert：同 id 覆盖 note/block/sel/quote
    await putAnnotation(db, rec({ id: "an1", created_at: 999, note_md: "edited", block_id: "b9", sel_start: 1, sel_end: 5, quote_snapshot: "q" }));
    const after = await getAnnotation(db, "P", "an1");
    check("upsert 覆盖 note_md", after?.note_md === "edited", after);
    check("upsert 覆盖 block_id（重锚）", after?.block_id === "b9", after);
    check("upsert 不改 created_at（ON CONFLICT 未列）", after?.created_at === 100, after);

    const upd = await updateAnnotation(db, "P", "an2", "patched");
    check("updateAnnotation 返回更新后记录", upd?.note_md === "patched", upd);
    check("updateAnnotation 不存在返 null", (await updateAnnotation(db, "P", "ghost", "x")) === null);

    await deleteAnnotation(db, "P", "an3");
    check("deleteAnnotation 生效", (await listAnnotations(db, "P")).length === 2);
    // 越权删不动别人 paper 的
    await deleteAnnotation(db, "OTHER", "an1");
    check("deleteAnnotation 越权不删", (await getAnnotation(db, "P", "an1")) !== null);
  }

  console.log("=== F1 service：createAnnotation 校验 + 锚点降级 ===");
  {
    const db = memDb();
    const ctx = { db } as ServiceCtx;
    const blocks = [mkBlock({ id: "b1", anchor: "b1" }), mkBlock({ id: "b2", anchor: "b2" })];
    await savePaper(db, "P", mkPaper(blocks));

    // paper 未导入 → null
    check("createAnnotation paper 未导入 → null", (await createAnnotation(ctx, "NOPE", { block_id: "b1", note_md: "x" })) === null);

    // note 为空 / 过长
    await expectThrow("note 空 → empty_note", () => createAnnotation(ctx, "P", { block_id: "b1", note_md: "   " }), "empty_note");
    await expectThrow("note 过长 → note_too_long", () => createAnnotation(ctx, "P", { block_id: "b1", note_md: "x".repeat(ANNOTATION_NOTE_MAX + 1) }), "note_too_long");

    // block 不在论文 → block_not_found
    await expectThrow("孤儿 block → block_not_found", () => createAnnotation(ctx, "P", { block_id: "ghost", note_md: "x" }), "block_not_found");

    // 正常：精确 sel + snapshot 保留
    const a1 = await createAnnotation(ctx, "P", { block_id: "b1", note_md: "  trimmed  ", quote_snapshot: "hello", sel_start: 2, sel_end: 7 });
    check("note 去首尾空白", a1?.note_md === "trimmed", a1);
    check("sel_start/end 成对保留", a1?.sel_start === 2 && a1?.sel_end === 7, a1);
    check("quote_snapshot 保留", a1?.quote_snapshot === "hello", a1);
    check("created_at 写入", typeof a1?.created_at === "number" && a1!.created_at > 0);
    check("id 形如 an_*", !!a1?.id.startsWith("an_"), a1?.id);

    // 跨 block 选区降级：sel 不传 → null（block 级锚定）
    const a2 = await createAnnotation(ctx, "P", { block_id: "b2", note_md: "block-level" });
    check("跨 block 降级：sel_start/end = null", a2?.sel_start === null && a2?.sel_end === null, a2);
    check("空快照：quote_snapshot = null", a2?.quote_snapshot === null, a2);

    // 非法 sel（start>end / 负 / NaN）→ 降级 null
    const a3 = await createAnnotation(ctx, "P", { block_id: "b1", note_md: "bad sel", sel_start: 9, sel_end: 3 });
    check("start>end → 降级 null", a3?.sel_start === null && a3?.sel_end === null, a3);
    const a4 = await createAnnotation(ctx, "P", { block_id: "b1", note_md: "neg sel", sel_start: -1, sel_end: 5 });
    check("负 sel → 降级 null", a4?.sel_start === null && a4?.sel_end === null, a4);

    // snapshot 超长截断
    const a5 = await createAnnotation(ctx, "P", { block_id: "b1", note_md: "long quote", quote_snapshot: "q".repeat(ANNOTATION_SNAPSHOT_MAX + 500) });
    check("snapshot 截断到上限", a5?.quote_snapshot?.length === ANNOTATION_SNAPSHOT_MAX, a5?.quote_snapshot?.length);

    // list 视图按 ASC
    const view = await listAnnotationsView(ctx, "P");
    check("listAnnotationsView 返回全部", (view?.length ?? 0) === 5, view?.length);
    check("listAnnotationsView paper 未导入 → null", (await listAnnotationsView(ctx, "NOPE")) === null);
  }

  console.log("=== F1 service：edit / remove ===");
  {
    const db = memDb();
    const ctx = { db } as ServiceCtx;
    await savePaper(db, "P", mkPaper([mkBlock({ id: "b1" })]));
    const a = await createAnnotation(ctx, "P", { block_id: "b1", note_md: "orig" });
    const aid = a!.id;

    const edited = await editAnnotation(ctx, "P", aid, "  updated note  ");
    check("editAnnotation 更新 + trim", edited?.note_md === "updated note", edited);
    await expectThrow("edit 空 note → empty_note", () => editAnnotation(ctx, "P", aid, "  "), "empty_note");
    await expectThrow("edit 不存在 → annotation_not_found", () => editAnnotation(ctx, "P", "ghost", "x"), "annotation_not_found");
    check("editAnnotation paper 未导入 → null", (await editAnnotation(ctx, "NOPE", aid, "x")) === null);

    check("removeAnnotation 成功 → true", (await removeAnnotation(ctx, "P", aid)) === true);
    check("removeAnnotation 后 list 空", (await listAnnotationsView(ctx, "P"))?.length === 0);
    check("removeAnnotation 幂等再删 → true", (await removeAnnotation(ctx, "P", aid)) === true);
    check("removeAnnotation paper 未导入 → false", (await removeAnnotation(ctx, "NOPE", aid)) === false);
  }

  if (fail) {
    console.log(`\nFAIL: ${fail} 个断言失败`);
    process.exit(1);
  }
  console.log("\nALL F1 ANNOTATION TESTS PASS ✅");
}

main();
