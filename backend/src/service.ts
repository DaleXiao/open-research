// M2 编排服务：parse → 落地 → 懒翻（缓存优先）→ 对照视图。
// 把 Worker 路由与底层 store/translate 解耦，便于单测。

// 编排服务：import 改为接收「前端已解析」的 blocks，worker 零解析零 fetch，
// 只校验 + 落库。解析在用户浏览器跑（根除 CF Worker CPU 墙 1102）。

import type { ParsedPaper, Block, BlockType } from "./parse/types.js";
import {
  type D1Like,
  savePaper,
  getPaperBlocks,
  getTranslations,
  putTranslation,
  listPapers,
  deletePaper,
  type DeletePaperResult,
  type CachedTranslation,
  type PaperListItem,
} from "./store/d1.js";
import {
  translateBlock,
  type TranslateConfig,
  type BlockTranslation,
} from "./translate/engine.js";
import { GatewayError } from "./llm/gateway.js";
import { buildBilingualView, type BilingualView } from "./render/bilingual.js";
import {
  getQaHistory,
  putQa,
  type QaRecord,
  listAnnotations,
  putAnnotation,
  updateAnnotation,
  deleteAnnotation,
  type AnnotationRecord,
  getMindmap,
  putMindmap,
} from "./store/d1.js";
import {
  generateMindmap,
  MINDMAP_MODEL,
  type MindmapConfig,
  type MindmapLang,
} from "./mindmap/engine.js";
import { ensureEmbeddings, embedQuery, type EmbedConfig, EMBED_MODEL } from "./qa/embed.js";
import { topK } from "./qa/retrieve.js";
import {
  selectionContext,
  buildSelectionPrompt,
  buildFullPrompt,
  answer as answerQa,
  backfillCited,
  RAG_TOP_K,
  QA_MODEL,
  type QaConfig,
  type QaScope,
  type QaLang,
} from "./qa/engine.js";

export interface ServiceCtx {
  db: D1Like;
  translate: TranslateConfig;
  fetchOpts?: { fetchImpl?: typeof fetch; timeoutMs?: number };
  /** M5 QA：embedding + chat 配置（同走 gateway）。 */
  qa?: {
    gateway: import("./llm/gateway.js").GatewayConfig;
    qaModel?: string;
    embedModel?: string;
  };
}

/** 稳定 paper id：复用带版本 arxiv_id；PDF/任意 http(s) URL 用规范化后 SHA-256 hash
 *  （pdf-<hex>，同一篇多 URL 变体归一）；其余非 URL slug。
 * ⚠ paper_id 现由前端 parse-client 算（同规则），worker 不再解析。本函数
 *   仅保留供历史/边界（已不在 import 主路径）。
 */
export async function paperIdFor(input: string): Promise<string> {
  // arXiv id 直接复用（带版本）。
  const m = input.trim().match(/(\d{4}\.\d{4,5})(v\d+)?/) ||
    input.trim().match(/([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i);
  if (m) return m[2] ? m[1] + m[2] : m[1];
  return input.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

// ---- ：client-parse import 契约 ----

export interface ClientPaperPayload {
  paper_id: string;
  source_url: string;
  source_type: "arxiv" | "pdf";
  arxiv_id: string | null;
  title: string;
  blocks: Block[];
  toc?: ParsedPaper["toc"];
}

export class ImportValidationError extends Error {
  code = "invalid_payload";
  constructor(message: string) {
    super(message);
    this.name = "ImportValidationError";
  }
}

const VALID_BLOCK_TYPES = new Set<BlockType>(["para", "math", "figure", "heading"]);

/**
 * 校验前端提交的 ParsedPaper payload。worker 零解析，但**必须**校验结构
 * （防脏数据落库污染翻译缓存/批注锚定）。校验 block 必备字段 + id 非空 + type 合法。
 */
function validateClientPayload(p: ClientPaperPayload): void {
  if (!p || typeof p !== "object") throw new ImportValidationError("payload 非对象");
  if (!p.paper_id || typeof p.paper_id !== "string") throw new ImportValidationError("缺 paper_id");
  if (!p.source_url || typeof p.source_url !== "string") throw new ImportValidationError("缺 source_url");
  if (p.source_type !== "arxiv" && p.source_type !== "pdf") throw new ImportValidationError("source_type 非法");
  if (typeof p.title !== "string") throw new ImportValidationError("缺 title");
  if (!Array.isArray(p.blocks)) throw new ImportValidationError("blocks 非数组");
  if (p.blocks.length === 0) throw new ImportValidationError("blocks 为空（解析得 0 block）");
  const seen = new Set<string>();
  for (let i = 0; i < p.blocks.length; i++) {
    const b = p.blocks[i];
    if (!b || typeof b !== "object") throw new ImportValidationError(`block[${i}] 非对象`);
    if (!b.id || typeof b.id !== "string") throw new ImportValidationError(`block[${i}] 缺 id`);
    if (seen.has(b.id)) throw new ImportValidationError(`block id 重复：${b.id}`);
    seen.add(b.id);
    if (!VALID_BLOCK_TYPES.has(b.type)) throw new ImportValidationError(`block[${i}] type 非法：${b.type}`);
    if (typeof b.order !== "number") throw new ImportValidationError(`block[${i}] 缺 order`);
    if (typeof b.translate !== "boolean") throw new ImportValidationError(`block[${i}] 缺 translate`);
  }
}

/**
 * 落地前端已解析的 paper（幂等 upsert）。worker **零解析零 fetch arxiv**
 * → 根除 1102。校验 payload 结构后组装 ParsedPaper → savePaper(status=ready)。
 *  - 非 force 且已有 blocks → 返回 cached（保现有缓存语义）。
 *  - 否则校验 + savePaper → ready。
 */
export async function saveClientPaper(
  ctx: ServiceCtx,
  payload: ClientPaperPayload,
  opts: { force?: boolean } = {},
): Promise<{ paper_id: string; paper: ParsedPaper; cached: boolean }> {
  validateClientPayload(payload);
  if (!opts.force) {
    const existing = await getPaperBlocks(ctx.db, payload.paper_id);
    if (existing) return { paper_id: payload.paper_id, paper: existing, cached: true };
  }
  // 组装 ParsedPaper（blocks 已带稳定 id；text_zh 解析阶段恒 null，懒翻回填）。
  const paper: ParsedPaper = {
    source_url: payload.source_url,
    source_type: payload.source_type,
    arxiv_id: payload.arxiv_id ?? null,
    title: payload.title,
    abstract: null,
    toc: payload.toc ?? [],
    blocks: payload.blocks,
    meta: {
      parser: "client-v1",
      block_count: payload.blocks.length,
      parsed_at: Date.now(),
    },
  };
  await savePaper(ctx.db, payload.paper_id, paper);
  return { paper_id: payload.paper_id, paper, cached: false };
}

/** 取对照视图（不触发翻译，只读缓存）。 */
/**
 * 取对照视图（不触发翻译，只读缓存）。
 * status 感知——记录不存在返 null（404）；存在但 parsing/failed 返带 status
 * 的轻视图（blocks 为空）供前端轮询；ready 返完整对照视图。
 */
export async function getView(
  ctx: ServiceCtx,
  paperId: string,
): Promise<BilingualView | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  // client-parse 后 worker 只有 ready（有 blocks）或不存在。无 blocks → null（404）。
  // 历史 parsing 残留行（CLIP 2103， Queue 丢弃未回写，blocks_json 空）也走这里
  // 返 null → 前端视作未导入 → 用户重新 import → 客户端解析覆盖。不再查不存在的 fail_reason 列。
  if (!paper) return null;
  const trans = await getTranslations(ctx.db, paperId);
  return buildBilingualView(paperId, paper, trans);
}

/**
 * 懒翻一组 block（默认整篇所有 translate=true 的未翻 block）。
 * 缓存命中跳过，未命中调 qwen-mt 并写缓存。返回本次翻译 + 命中统计。
 *
 * ⚠ CF Worker 单次 invocation 的 subrequest 上限（Free=50）：一次最多 fan-out
 * MAX_FANOUT_PER_CALL 个未翻 block，超出的留给客户端下一次调用（remaining/has_more）。
 *
 * M5.4 容错：
 *  - partial fail：单个 block 翻译抛错不再拖垮整批（不再 Promise.all reject），
 *    成功的照常落缓存 + 返回；失败的计入 failed_block_ids 供客户端重试。
 *  - 并发降级：观测到 429（rate_limited）时动态减半有效并发（min 1），压住 fan-out
 *    宽度，与 gateway 层的 429 重试配合让瞬时峰值自愈。
 */
// F3-fix2: 35→8 保守收敛（实测后定数不拍脑袋）。
//   实测 subrequest 路径：gateway 走 service binding（env.API_LLM，**不计 subrequest**），
//   单 invocation 实际 subrequest = D1 写 putTranslation ×N + getPaperBlocks/getTranslations 2 读。
//   35 时 = 37 subrequest（< 50 cap）→ 所以 503 主因是 **CPU/duration 墙**：单 invocation
//   并发 await 35 个 qwen-mt 翻译（每个可能数秒）撞 CF Worker 壁钟/CPU 预算。
//   降到 8：每 invocation 轻（≤8 翻译 + ≤8 D1 写，远低于壁），客户端 translateAll
//   多批循环补齐 + 批级退避，吞吐不损（仅多几趟往返）。配 concurrency=4 串并。
const MAX_FANOUT_PER_CALL = 8;

export async function translatePaper(
  ctx: ServiceCtx,
  paperId: string,
  opts: { blockIds?: string[]; concurrency?: number; force?: boolean } = {},
): Promise<{
  translated: BlockTranslation[];
  cached_hit: number;
  skipped_untranslatable: number;
  remaining: number;
  has_more: boolean;
  /** 本次尝试但翻译失败的 block id（已重试仍败）；客户端可只重试这些。 */
  failed: string[];
} | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;

  let target = paper.blocks;
  if (opts.blockIds && opts.blockIds.length) {
    const want = new Set(opts.blockIds);
    target = paper.blocks.filter((b) => want.has(b.id));
  }
  const translatable = target.filter(
    (b) => b.translate && (b.text_en?.trim()?.length ?? 0) > 0,
  );
  const skipped = target.length - translatable.length;

  // 缓存命中预查
  const existing = opts.force
    ? new Map<string, CachedTranslation>()
    : await getTranslations(
        ctx.db,
        paperId,
        translatable.map((b) => b.id),
      );
  const allTodo = translatable.filter((b) => !existing.has(b.id));
  // 限制单次 fan-out，超出部分留给下一次调用（避免超 CF subrequest cap）
  const todo = allTodo.slice(0, MAX_FANOUT_PER_CALL);
  const remaining = allTodo.length - todo.length;

  const translated: BlockTranslation[] = [];
  const failed: string[] = [];
  const requested = Math.max(1, opts.concurrency ?? 4);
  // 自适应并发：初始 = 请求值；观测到 429 时减半（不超 todo 长度）。
  let effConcurrency = Math.min(requested, Math.max(1, todo.length));
  let cursor = 0;

  /** 观测到限流 → 并发减半（让剩余 worker 自然收敛）。 */
  function degradeOnRateLimit() {
    if (effConcurrency > 1) {
      effConcurrency = Math.max(1, Math.floor(effConcurrency / 2));
    }
  }

  async function worker(slot: number) {
    while (cursor < todo.length) {
      // 并发降级：若当前 slot 超出动态并发上限，该 worker 退出（压窄实际并发）。
      if (slot >= effConcurrency) return;
      const i = cursor++;
      const block = todo[i];
      try {
        const tr = await translateBlock(block, ctx.translate);
        if (tr) {
          await putTranslation(ctx.db, paperId, tr);
          translated.push(tr);
        }
      } catch (e) {
        // partial fail 容错：该 block 记为失败，不拖垮整批。
        failed.push(block.id);
        if (e instanceof GatewayError && e.rateLimited) degradeOnRateLimit();
      }
    }
  }
  await Promise.all(
    Array.from({ length: effConcurrency }, (_, slot) => worker(slot)),
  );

  // 保序
  const order = new Map(translatable.map((b, i) => [b.id, i]));
  translated.sort((a, b) => (order.get(a.block_id)! - order.get(b.block_id)!));

  return {
    translated,
    cached_hit: existing.size,
    skipped_untranslatable: skipped,
    remaining,
    has_more: remaining > 0,
    failed,
  };
}

// ───────────────────────── M5 QA（选区问 + 全文 RAG）─────────────────────────

export interface AskResult {
  answer: string;
  cited_block_ids: string[];
  model: string;
  scope: QaScope;
  /** 全文问时：本次是否懒生成了 embedding（首次问全文 true） */
  embeddings_generated?: boolean;
}

export class QaError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "QaError";
    this.code = code;
  }
}

function qaCfgFrom(ctx: ServiceCtx): { qa: QaConfig; embed: EmbedConfig } {
  if (!ctx.qa) throw new QaError("QA 未配置 gateway", "qa_unconfigured");
  const gateway = ctx.qa.gateway;
  return {
    qa: { gateway, model: ctx.qa.qaModel ?? QA_MODEL },
    embed: { gateway, model: ctx.qa.embedModel ?? EMBED_MODEL },
  };
}

// ---- F4 思维导图 ----

export interface MindmapResult {
  markmap_md: string;
  model: string;
  lang: MindmapLang;
  cached: boolean;
}

/** 复用 QA 的 gateway 配置作脑图配置（同走 gateway）。 */
function mindmapCfgFrom(ctx: ServiceCtx): MindmapConfig {
  if (!ctx.qa) throw new QaError("脑图未配置 gateway", "mindmap_unconfigured");
  return { gateway: ctx.qa.gateway, model: ctx.qa.qaModel ?? MINDMAP_MODEL };
}

/**
 * 生成（或取缓存）一篇 paper 某语言的 markmap 思维导图。
 * 缓存优先：命中且 !force → cached:true。否则调 LLM 生成并落 mindmaps 表。
 * paper 未导入返回 null（路由层转 404）。
 */
export async function mindmapPaper(
  ctx: ServiceCtx,
  paperId: string,
  opts: { lang?: MindmapLang; force?: boolean } = {},
): Promise<MindmapResult | null> {
  const lang: MindmapLang = opts.lang === "en" ? "en" : "zh";
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;

  if (!opts.force) {
    const hit = await getMindmap(ctx.db, paperId, lang);
    if (hit) {
      return { markmap_md: hit.markmap_md, model: hit.model, lang, cached: true };
    }
  }

  const cfg = mindmapCfgFrom(ctx);
  const { markmap_md, model } = await generateMindmap(cfg, paper, lang);
  await putMindmap(ctx.db, {
    paper_id: paperId,
    lang,
    markmap_md,
    model,
    created_at: Date.now(),
  });
  return { markmap_md, model, lang, cached: false };
}

/**
 * 问 paper：scope=selection（选中 block + 邻近）或 full（RAG top-k）。
 * 回答语言跟随 lang。落 qa_history。返回 answer + cited_block_ids。
 */
export async function askPaper(
  ctx: ServiceCtx,
  paperId: string,
  opts: { scope: QaScope; question: string; lang: QaLang; block_id?: string },
): Promise<AskResult | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;
  const q = opts.question?.trim();
  if (!q) throw new QaError("问题为空", "empty_question");
  const lang: QaLang = opts.lang === "en" ? "en" : "zh";
  const { qa, embed } = qaCfgFrom(ctx);

  let result: AskResult;

  if (opts.scope === "selection") {
    if (!opts.block_id) throw new QaError("选区问必须传 block_id", "missing_block_id");
    const ctxBlocks = selectionContext(paper.blocks, opts.block_id);
    if (ctxBlocks.length === 0) throw new QaError("选中 block 不存在", "block_not_found");
    const prompt = buildSelectionPrompt(ctxBlocks, opts.block_id, q, lang);
    const a = await answerQa(qa, prompt);
    // M5.1：cited 权威来源 = 选区上下文（选中 block 置首 + 前后文），不靠模型自报。
    const authoritative = [
      opts.block_id,
      ...ctxBlocks.map((b) => b.id).filter((id) => id !== opts.block_id),
    ];
    const cited = backfillCited(authoritative, a.model_cited);
    result = {
      answer: a.answer,
      cited_block_ids: cited,
      model: a.model,
      scope: "selection",
    };
  } else {
    // full：懒生成 embedding → query 向量 → top-k → prompt
    const { vectors, lazyGenerated } = await ensureEmbeddings(
      ctx.db,
      paperId,
      paper.blocks,
      embed,
    );
    const qVec = await embedQuery(embed, q);
    const hits = topK(qVec, vectors, RAG_TOP_K);
    const byId = new Map(paper.blocks.map((b) => [b.id, b]));
    const retrieved = hits.map((h) => byId.get(h.block_id)!).filter(Boolean);
    const prompt = buildFullPrompt(retrieved, q, lang);
    const a = await answerQa(qa, prompt);
    // M5.1：cited 权威来源 = RAG 实际命中的 top-k block ids，不靠模型自报。
    const authoritative = retrieved.map((b) => b.id);
    const cited = backfillCited(authoritative, a.model_cited);
    result = {
      answer: a.answer,
      cited_block_ids: cited,
      model: a.model,
      scope: "full",
      embeddings_generated: lazyGenerated,
    };
  }

  // 落历史
  await putQa(ctx.db, {
    id: `qa_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    paper_id: paperId,
    scope: result.scope,
    question: q,
    answer: result.answer,
    cited_block_ids: result.cited_block_ids,
    created_at: Date.now(),
  });

  return result;
}

/** 取 paper 历史 QA（按时间升序）。paper 未导入返回 null。 */
export async function listQa(
  ctx: ServiceCtx,
  paperId: string,
): Promise<QaRecord[] | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;
  return getQaHistory(ctx.db, paperId);
}

/** F2: 倒序导入记录列表（进站恢复 + 最近论文）。 */
export async function listPapersView(
  ctx: ServiceCtx,
  limit?: number,
): Promise<PaperListItem[]> {
  return listPapers(ctx.db, limit ?? undefined);
}

/** F5: 级联删除一篇 paper 及全部派生数据。未导入返回 null（路由转 404）。 */
export async function deletePaperView(
  ctx: ServiceCtx,
  paperId: string,
): Promise<DeletePaperResult | null> {
  return deletePaper(ctx.db, paperId);
}

// ────────────────── F1 批注/笔记（划词记笔记 + 锚定原文 + 书签）──────────────────

export class AnnotationError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "AnnotationError";
    this.code = code;
  }
}

/** 批注正文最大长度（防单条写爆）。 */
export const ANNOTATION_NOTE_MAX = 8000;
/** quote_snapshot 最大长度（跨大段选区截断，仅作漂移校验）。 */
export const ANNOTATION_SNAPSHOT_MAX = 2000;

/** 校验 + 规范 note_md（去首尾空白，空/超长 招 AnnotationError）。 */
function normalizeNote(noteMd: string): string {
  const note = (noteMd ?? "").trim();
  if (!note) throw new AnnotationError("笔记为空", "empty_note");
  if (note.length > ANNOTATION_NOTE_MAX) {
    throw new AnnotationError("笔记过长", "note_too_long");
  }
  return note;
}

/**
 * 新建一条批注。paper 未导入返回 null；note_md 空 招 empty_note。
 * block_id 必须落在该 paper 某个 block 上（防孤儿锚点 → block_not_found）。
 * sel_start/end 成对且合法（有限数 / 0<=start<=end）才保留，否则降级 block 级（null）。
 */
export async function createAnnotation(
  ctx: ServiceCtx,
  paperId: string,
  opts: {
    block_id: string;
    note_md: string;
    quote_snapshot?: string | null;
    sel_start?: number | null;
    sel_end?: number | null;
  },
): Promise<AnnotationRecord | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;
  const note = normalizeNote(opts.note_md);
  if (!opts.block_id || !paper.blocks.some((b) => b.id === opts.block_id)) {
    throw new AnnotationError("block_id 不在本论文", "block_not_found");
  }
  let sStart: number | null = null;
  let sEnd: number | null = null;
  const a = opts.sel_start;
  const b = opts.sel_end;
  if (
    typeof a === "number" && typeof b === "number" &&
    Number.isFinite(a) && Number.isFinite(b) && a >= 0 && b >= a
  ) {
    sStart = Math.floor(a);
    sEnd = Math.floor(b);
  }
  const snapshot = opts.quote_snapshot
    ? String(opts.quote_snapshot).slice(0, ANNOTATION_SNAPSHOT_MAX)
    : null;
  const rec: AnnotationRecord = {
    id: `an_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    paper_id: paperId,
    block_id: opts.block_id,
    sel_start: sStart,
    sel_end: sEnd,
    quote_snapshot: snapshot,
    note_md: note,
    created_at: Date.now(),
  };
  await putAnnotation(ctx.db, rec);
  return rec;
}

/** 取一篇 paper 的全部批注（按时间升序）。paper 未导入返回 null。 */
export async function listAnnotationsView(
  ctx: ServiceCtx,
  paperId: string,
): Promise<AnnotationRecord[] | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;
  return listAnnotations(ctx.db, paperId);
}

/** 编辑一条批注 note_md。paper 未导入返回 null；批注不存在招 annotation_not_found。 */
export async function editAnnotation(
  ctx: ServiceCtx,
  paperId: string,
  annotationId: string,
  noteMd: string,
): Promise<AnnotationRecord | null> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return null;
  const note = normalizeNote(noteMd);
  const updated = await updateAnnotation(ctx.db, paperId, annotationId, note);
  if (!updated) throw new AnnotationError("批注不存在", "annotation_not_found");
  return updated;
}

/** 删除一条批注。paper 未导入返回 false；删除成功（幂等）返回 true。 */
export async function removeAnnotation(
  ctx: ServiceCtx,
  paperId: string,
  annotationId: string,
): Promise<boolean> {
  const paper = await getPaperBlocks(ctx.db, paperId);
  if (!paper) return false;
  await deleteAnnotation(ctx.db, paperId, annotationId);
  return true;
}
