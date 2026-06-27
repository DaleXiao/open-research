// D1 持久化层：papers 元数据 + blocks json + translations 翻译缓存。
// blocks json 直接存 papers.blocks_json 列（CF 账号未启用 R2，0002 migration 加列）。
// 抽象出最小 D1 接口，便于单测注入内存 mock（不引 wrangler 运行时）。

import type { ParsedPaper, Block } from "../parse/types.js";
import type { BlockTranslation } from "../translate/engine.js";

// ---- 最小 D1 接口（与 @cloudflare/workers-types 兼容子集）----
export interface D1Like {
  prepare(query: string): D1StmtLike;
}
export interface D1StmtLike {
  bind(...vals: unknown[]): D1StmtLike;
  first<T = unknown>(col?: string): Promise<T | null>;
  run(): Promise<unknown>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

export interface PaperRow {
  id: string;
  source_url: string;
  source_type: string;
  title: string | null;
  arxiv_id: string | null;
  status: string;
  block_count: number;
  blocks_json: string | null;
  created_at: number;
  updated_at: number;
}

// ---- ：paper 状态（解析在客户端，worker 侧只有 ready）----
// prod papers 表只有 status 列（0001 default 'parsed'），无 fail_reason/enqueued_at
// （ 的 0004 migration 从未 apply 到 prod，随 一并删除）。
// client-parse 后 worker 只落 ready；savePaper 写 status='ready'（旧行 'parsed' 不影响读）。

/** 落地解析结果：元数据 + blocks json 全进 D1。幂等 upsert。 */
export async function savePaper(
  db: D1Like,
  paperId: string,
  paper: ParsedPaper,
): Promise<PaperRow> {
  const now = Date.now();
  const blocksJson = JSON.stringify(paper);
  await db
    .prepare(
      `INSERT INTO papers (id, source_url, source_type, title, arxiv_id, status, block_count, blocks_json, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'ready', ?6, ?7, ?8, ?8)
       ON CONFLICT(id) DO UPDATE SET
         source_url=?2, title=?4, arxiv_id=?5, status='ready',
         block_count=?6, blocks_json=?7, updated_at=?8`,
    )
    .bind(
      paperId,
      paper.source_url,
      paper.source_type,
      paper.title || null,
      paper.arxiv_id,
      paper.blocks.length,
      blocksJson,
      now,
    )
    .run();
  return {
    id: paperId,
    source_url: paper.source_url,
    source_type: paper.source_type,
    title: paper.title || null,
    arxiv_id: paper.arxiv_id,
    status: "ready",
    block_count: paper.blocks.length,
    blocks_json: blocksJson,
    created_at: now,
    updated_at: now,
  };
}

export async function getPaperRow(db: D1Like, paperId: string): Promise<PaperRow | null> {
  return db.prepare(`SELECT * FROM papers WHERE id=?1`).bind(paperId).first<PaperRow>();
}

// ---- F2: 导入记录列表（进站恢复 + 最近论文）----

/** 列表项：仅暴露列表所需元数据，不含 blocks_json（大字段）。 */
export interface PaperListItem {
  id: string;
  title: string | null;
  source_type: string;
  arxiv_id: string | null;
  block_count: number;
  created_at: number;
}

/** 默认列表条数（与端点 ?limit 默认一致）。 */
export const DEFAULT_PAPERS_LIMIT = 30;
/** 列表条数上限（防一次拉爆，超量历史用分页留给后续 task）。 */
export const MAX_PAPERS_LIMIT = 100;

/** 倒序导入列表（按 created_at DESC）。只取列表所需轻字段，不读 blocks_json。 */
export async function listPapers(
  db: D1Like,
  limit: number = DEFAULT_PAPERS_LIMIT,
): Promise<PaperListItem[]> {
  const n = Math.min(MAX_PAPERS_LIMIT, Math.max(1, Math.floor(limit) || DEFAULT_PAPERS_LIMIT));
  const res = await db
    .prepare(
      `SELECT id, title, source_type, arxiv_id, block_count, created_at
       FROM papers ORDER BY created_at DESC LIMIT ?1`,
    )
    .bind(n)
    .all<PaperListItem>();
  return res.results;
}

export async function getPaperBlocks(
  db: D1Like,
  paperId: string,
): Promise<ParsedPaper | null> {
  const row = await db
    .prepare(`SELECT blocks_json FROM papers WHERE id=?1`)
    .bind(paperId)
    .first<{ blocks_json: string | null }>();
  if (!row?.blocks_json) return null;
  return JSON.parse(row.blocks_json) as ParsedPaper;
}

// ---- translations 缓存 ----

export interface CachedTranslation {
  block_id: string;
  text_zh: string;
  model: string;
  degraded: boolean;
}

// D1 限制单条语句最多 100 个绑定参数；IN 列表里每个 block_id 占 1 个，paper_id 再占 1。
// 单篇论文 50-150 block，子集查询很容易 >99 个 block_id 触发崩溃。
// 因此把 IN 列表按 80 一批切分（80 + 1 paper_id = 81，留足余量），逐批查询后合并。
const TRANSLATION_IN_CHUNK = 80;

/** 读取已缓存的翻译（可指定 block_id 子集，省略=全部）。 */
export async function getTranslations(
  db: D1Like,
  paperId: string,
  blockIds?: string[],
): Promise<Map<string, CachedTranslation>> {
  const map = new Map<string, CachedTranslation>();
  const collect = (rows: any[]) => {
    for (const r of rows) {
      map.set(r.block_id, {
        block_id: r.block_id,
        text_zh: r.text_zh,
        model: r.model,
        degraded: !!r.degraded,
      });
    }
  };

  if (blockIds && blockIds.length) {
    // 按 TRANSLATION_IN_CHUNK 分批，避开 D1 100 参数上限。
    for (let i = 0; i < blockIds.length; i += TRANSLATION_IN_CHUNK) {
      const chunk = blockIds.slice(i, i + TRANSLATION_IN_CHUNK);
      const placeholders = chunk.map((_, j) => `?${j + 2}`).join(",");
      const res = await db
        .prepare(
          `SELECT block_id, text_zh, model, degraded FROM translations
         WHERE paper_id=?1 AND block_id IN (${placeholders})`,
        )
        .bind(paperId, ...chunk)
        .all();
      collect(res.results);
    }
  } else {
    const res = await db
      .prepare(`SELECT block_id, text_zh, model, degraded FROM translations WHERE paper_id=?1`)
      .bind(paperId)
      .all();
    collect(res.results);
  }
  return map;
}

/** 写入/更新一条翻译缓存。 */
export async function putTranslation(
  db: D1Like,
  paperId: string,
  tr: BlockTranslation,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO translations (paper_id, block_id, text_zh, model, degraded, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT(paper_id, block_id) DO UPDATE SET
         text_zh=?3, model=?4, degraded=?5, created_at=?6`,
    )
    .bind(paperId, tr.block_id, tr.text_zh, tr.model, tr.degraded ? 1 : 0, Date.now())
    .run();
}

// ---- M5 embeddings 缓存（RAG 向量）----

export interface StoredEmbedding {
  block_id: string;
  vector: number[];
  dim: number;
  model: string;
}

/** 读取一篇 paper 已缓存的全部 block 向量。 */
export async function getEmbeddings(
  db: D1Like,
  paperId: string,
): Promise<Map<string, StoredEmbedding>> {
  const res = await db
    .prepare(`SELECT block_id, vector_json, dim, model FROM embeddings WHERE paper_id=?1`)
    .bind(paperId)
    .all<{ block_id: string; vector_json: string; dim: number; model: string }>();
  const map = new Map<string, StoredEmbedding>();
  for (const r of res.results) {
    let vec: number[];
    try {
      vec = JSON.parse(r.vector_json);
    } catch {
      continue;
    }
    map.set(r.block_id, { block_id: r.block_id, vector: vec, dim: r.dim, model: r.model });
  }
  return map;
}

/** 批量写入 block 向量（懒生成）。幂等 upsert。 */
export async function putEmbeddings(
  db: D1Like,
  paperId: string,
  model: string,
  vectors: { block_id: string; vector: number[] }[],
): Promise<void> {
  const now = Date.now();
  for (const v of vectors) {
    await db
      .prepare(
        `INSERT INTO embeddings (paper_id, block_id, vector_json, dim, model, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)
         ON CONFLICT(paper_id, block_id) DO UPDATE SET
           vector_json=?3, dim=?4, model=?5, created_at=?6`,
      )
      .bind(paperId, v.block_id, JSON.stringify(v.vector), v.vector.length, model, now)
      .run();
  }
}

// ---- M5 qa_history ----

export interface QaRecord {
  id: string;
  paper_id: string;
  scope: string;
  question: string;
  answer: string | null;
  cited_block_ids: string[];
  created_at: number;
}

/** 读取一篇 paper 的历史 QA（按时间升序）。 */
export async function getQaHistory(db: D1Like, paperId: string): Promise<QaRecord[]> {
  const res = await db
    .prepare(
      `SELECT id, paper_id, scope, question, answer, cited_block_ids, created_at
       FROM qa_history WHERE paper_id=?1 ORDER BY created_at ASC`,
    )
    .bind(paperId)
    .all<{
      id: string;
      paper_id: string;
      scope: string;
      question: string;
      answer: string | null;
      cited_block_ids: string | null;
      created_at: number;
    }>();
  return res.results.map((r) => {
    let cited: string[] = [];
    if (r.cited_block_ids) {
      try {
        cited = JSON.parse(r.cited_block_ids);
      } catch {
        cited = [];
      }
    }
    return {
      id: r.id,
      paper_id: r.paper_id,
      scope: r.scope,
      question: r.question,
      answer: r.answer,
      cited_block_ids: cited,
      created_at: r.created_at,
    };
  });
}

/** 写入一条 QA 记录。 */
export async function putQa(db: D1Like, rec: QaRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO qa_history (id, paper_id, scope, question, answer, cited_block_ids, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
    )
    .bind(
      rec.id,
      rec.paper_id,
      rec.scope,
      rec.question,
      rec.answer,
      JSON.stringify(rec.cited_block_ids),
      rec.created_at,
    )
    .run();
}

// ---- F1 annotations（划词笔记 + 锚定原文 + 书签）----
// annotations 表已在 0001_init 建好（id/paper_id/block_id/sel_start/sel_end/quote_snapshot/note_md/created_at），
// idx_annotations_paper(paper_id, block_id) 已建。本期填充 D1 存取层。

export interface AnnotationRecord {
  id: string;
  paper_id: string;
  block_id: string;
  /** 段内字符 offset（best-effort，精确高亮）。跨 block 选区降级 block 级 → null。 */
  sel_start: number | null;
  sel_end: number | null;
  /** 选中文字快照（重渲染校验文本漂移）。 */
  quote_snapshot: string | null;
  /** 笔记正文（纯 markdown）。 */
  note_md: string;
  created_at: number;
}

interface AnnotationRow {
  id: string;
  paper_id: string;
  block_id: string;
  sel_start: number | null;
  sel_end: number | null;
  quote_snapshot: string | null;
  note_md: string | null;
  created_at: number;
}

function mapAnnotationRow(r: AnnotationRow): AnnotationRecord {
  return {
    id: r.id,
    paper_id: r.paper_id,
    block_id: r.block_id,
    sel_start: r.sel_start ?? null,
    sel_end: r.sel_end ?? null,
    quote_snapshot: r.quote_snapshot ?? null,
    note_md: r.note_md ?? "",
    created_at: r.created_at,
  };
}

const ANNOTATION_COLS =
  "id, paper_id, block_id, sel_start, sel_end, quote_snapshot, note_md, created_at";

/** 读取一篇 paper 的全部批注（按 created_at 升序，开页锚定全部笔记位置）。 */
export async function listAnnotations(
  db: D1Like,
  paperId: string,
): Promise<AnnotationRecord[]> {
  const res = await db
    .prepare(
      `SELECT ${ANNOTATION_COLS} FROM annotations WHERE paper_id=?1 ORDER BY created_at ASC`,
    )
    .bind(paperId)
    .all<AnnotationRow>();
  return res.results.map(mapAnnotationRow);
}

/** 写入一条批注。幂等 upsert（同 id 覆盖 block/sel/quote/note）。 */
export async function putAnnotation(db: D1Like, rec: AnnotationRecord): Promise<void> {
  await db
    .prepare(
      `INSERT INTO annotations (${ANNOTATION_COLS})
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
       ON CONFLICT(id) DO UPDATE SET
         block_id=?3, sel_start=?4, sel_end=?5, quote_snapshot=?6, note_md=?7`,
    )
    .bind(
      rec.id,
      rec.paper_id,
      rec.block_id,
      rec.sel_start ?? null,
      rec.sel_end ?? null,
      rec.quote_snapshot ?? null,
      rec.note_md,
      rec.created_at,
    )
    .run();
}

/** 取单条批注（限 paper_id 防越权）。不存在返回 null。 */
export async function getAnnotation(
  db: D1Like,
  paperId: string,
  annotationId: string,
): Promise<AnnotationRecord | null> {
  const row = await db
    .prepare(`SELECT ${ANNOTATION_COLS} FROM annotations WHERE id=?1 AND paper_id=?2`)
    .bind(annotationId, paperId)
    .first<AnnotationRow>();
  return row ? mapAnnotationRow(row) : null;
}

/** 编辑一条批注的 note_md。返回更新后的记录；不存在返回 null。 */
export async function updateAnnotation(
  db: D1Like,
  paperId: string,
  annotationId: string,
  noteMd: string,
): Promise<AnnotationRecord | null> {
  await db
    .prepare(`UPDATE annotations SET note_md=?3 WHERE id=?1 AND paper_id=?2`)
    .bind(annotationId, paperId, noteMd)
    .run();
  return getAnnotation(db, paperId, annotationId);
}

/** 删除一条批注（限 paper_id 防越权）。 */
export async function deleteAnnotation(
  db: D1Like,
  paperId: string,
  annotationId: string,
): Promise<void> {
  await db
    .prepare(`DELETE FROM annotations WHERE id=?1 AND paper_id=?2`)
    .bind(annotationId, paperId)
    .run();
}

// ---- F4 mindmaps（markmap 脑图缓存）----
// 每篇 paper × lang 一行；force 重生成走 INSERT OR REPLACE。

export interface MindmapRecord {
  paper_id: string;
  lang: string;
  markmap_md: string;
  model: string;
  created_at: number;
}

/** 读缓存的脑图（按 paper_id + lang）。无则 null。 */
export async function getMindmap(
  db: D1Like,
  paperId: string,
  lang: string,
): Promise<MindmapRecord | null> {
  const row = await db
    .prepare(
      `SELECT paper_id, lang, markmap_md, model, created_at
       FROM mindmaps WHERE paper_id=?1 AND lang=?2`,
    )
    .bind(paperId, lang)
    .first<MindmapRecord>();
  return row ?? null;
}

/** 写入/覆盖一篇 paper 某语言的脑图缓存。 */
export async function putMindmap(db: D1Like, rec: MindmapRecord): Promise<void> {
  await db
    .prepare(
      `INSERT OR REPLACE INTO mindmaps (paper_id, lang, markmap_md, model, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5)`,
    )
    .bind(rec.paper_id, rec.lang, rec.markmap_md, rec.model, rec.created_at)
    .run();
}

// ---- F5: 论文删除（级联清各表，不留孤儿）----

export interface DeletePaperResult {
  paper: number;
  translations: number;
  annotations: number;
  qa_history: number;
  embeddings: number;
  mindmaps: number;
}

/**
 * 级联删除一篇 paper 及其全部派生数据。paper 未导入返回 null（路由层转 404）。
 * 各表按 paper_id 清；papers 按 id。blocks 内联在 papers.blocks_json，无独立表。
 * 越权隔离：调用方已限定 paper_id（单用户工作区，删自己的）。
 * 返回各表删除行数（best-effort：D1 run() meta.changes 形状各 runtime 不一，缺省返回写入数估算）。
 */
export async function deletePaper(
  db: D1Like,
  paperId: string,
): Promise<DeletePaperResult | null> {
  // 先确认存在（否则 404，不静默成功）。
  const exists = await db
    .prepare(`SELECT id FROM papers WHERE id=?1`)
    .bind(paperId)
    .first<{ id: string }>();
  if (!exists) return null;

  const changesOf = (res: any): number => {
    const c = res?.meta?.changes ?? res?.changes ?? res?.meta?.rows_written;
    return typeof c === "number" ? c : 0;
  };

  // 派生表先删，papers 最后删（即便中途异常，孤儿也被清而非残留主记录）。
  const trans = changesOf(
    await db.prepare(`DELETE FROM translations WHERE paper_id=?1`).bind(paperId).run(),
  );
  const annos = changesOf(
    await db.prepare(`DELETE FROM annotations WHERE paper_id=?1`).bind(paperId).run(),
  );
  const qa = changesOf(
    await db.prepare(`DELETE FROM qa_history WHERE paper_id=?1`).bind(paperId).run(),
  );
  const embs = changesOf(
    await db.prepare(`DELETE FROM embeddings WHERE paper_id=?1`).bind(paperId).run(),
  );
  const mind = changesOf(
    await db.prepare(`DELETE FROM mindmaps WHERE paper_id=?1`).bind(paperId).run(),
  );
  const paper = changesOf(
    await db.prepare(`DELETE FROM papers WHERE id=?1`).bind(paperId).run(),
  );

  return {
    paper: paper || 1,
    translations: trans,
    annotations: annos,
    qa_history: qa,
    embeddings: embs,
    mindmaps: mind,
  };
}
