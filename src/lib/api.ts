// research-worker 后端 API 契约（M2 对照阅读）。
// 后端同源接管 /api/*，前端 fetch 相对路径。字段对齐 src/render/bilingual.ts BilingualView。

export type BlockType = "para" | "heading" | "math" | "figure";
export type ZhStatus = "none" | "pending" | "done";

export interface BilingualBlock {
  id: string;
  type: BlockType;
  sec: string;
  order: number;
  level: number;
  text_en: string;
  text_zh: string | null;
  latex: string | null;
  img_url: string | null;
  caption: string | null;
  anchor: string;
  translate: boolean;
  zh_status: ZhStatus;
}

export interface SectionNode {
  id: string;
  title: string;
  level: number;
  children: SectionNode[];
}

// 解析挪客户端，worker 只返 ready（落库即就绪）。
export type PaperStatus = "ready";

export interface BilingualView {
  paper_id: string;
  /** ：worker 只返 ready（解析在客户端）。 */
  status?: PaperStatus;
  title: string;
  arxiv_id: string | null;
  source_url: string;
  toc: SectionNode[];
  blocks: BilingualBlock[];
  stats: { total: number; translatable: number; translated: number };
}

export interface ImportResult {
  paper_id: string;
  /** ：worker 只返 ready（前端已解析，落库即就绪）。 */
  status?: PaperStatus;
  cached: boolean;
  title?: string;
  arxiv_id?: string | null;
  block_count?: number;
  toc?: SectionNode[];
}

export interface TranslateResult {
  translated: { block_id: string; text_zh: string; model: string; degraded: boolean }[];
  cached_hit: number;
  skipped_untranslatable: number;
  remaining: number;
  has_more: boolean;
  /** F3-fix2：本次尝试但翻译失败的 block id（已重试仍败）；客户端可只重试这些。 */
  failed?: string[];
}

// F2：导入记录列表项（进站恢复 + 最近论文）。
export interface PaperListItem {
  id: string;
  title: string | null;
  source_type: string;
  arxiv_id: string | null;
  block_count: number;
  created_at: number;
}

export interface PapersListResult {
  papers: PaperListItem[];
}

// F4：思维导图。
export type MindmapLang = "zh" | "en";
export interface MindmapResult {
  markmap_md: string;
  model: string;
  lang: MindmapLang;
  cached: boolean;
}

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
  }
}

const BASE = "/api";

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + path, {
      ...init,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });
  } catch (e) {
    throw new ApiError(`网络错误：${String(e)}`, 0, "network");
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // F3-fix2：平台 502/503/504 返 HTML 错误页 → 非 JSON。按状态码分级为
    //   gateway_error（对齐 qa.ts），不再裸报“后端返回非 JSON”。
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError(`服务暂不可用（HTTP ${res.status}）`, res.status, "gateway_error");
    }
    throw new ApiError(`后端返回非 JSON（HTTP ${res.status}）`, res.status, "bad_json");
  }
  if (!res.ok) {
    // F3-fix2：后端返了 JSON 但 5xx → gateway 错误分级（对齐 qa.ts）。
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, "gateway_error");
    }
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, body?.code);
  }
  return body as T;
}

/**
 * ：import 改为提交「前端已解析」的 blocks。worker 零解析零 fetch，只校验+落库。
 * 解析在浏览器跑（parse-client.ts）——根除 CF Worker CPU 墙 1102。
 */
export interface ParsedPaperPayload {
  paper_id: string;
  source_url: string;
  source_type: "arxiv" | "pdf";
  arxiv_id: string | null;
  title: string;
  blocks: Array<{
    id: string;
    type: BlockType;
    sec: string;
    order: number;
    level: number;
    text_en: string;
    text_zh: string | null;
    latex: string | null;
    img_url: string | null;
    caption: string | null;
    anchor: string;
    translate: boolean;
  }>;
  toc?: SectionNode[];
}

/** 提交前端已解析的 blocks 给 worker 落库。返 ready。 */
export function importParsed(payload: ParsedPaperPayload): Promise<ImportResult> {
  return req<ImportResult>("/import", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 取对照视图。 */
export function getView(paperId: string): Promise<BilingualView> {
  return req<BilingualView>(`/paper/${encodeURIComponent(paperId)}`);
}

/** F2：倒序导入记录列表（进站恢复 + 最近论文）。 */
export function listPapers(limit = 30): Promise<PapersListResult> {
  return req<PapersListResult>(`/papers?limit=${encodeURIComponent(String(limit))}`);
}

// F5：论文删除（级联清数据）。
export interface DeletePaperResult {
  paper_id: string;
  deleted: {
    paper: number;
    translations: number;
    annotations: number;
    qa_history: number;
    embeddings: number;
    mindmaps: number;
  };
}

/** 删除一篇 paper（级联清除派生数据）。404 抛 ApiError。 */
export function deletePaper(paperId: string): Promise<DeletePaperResult> {
  return req<DeletePaperResult>(`/paper/${encodeURIComponent(paperId)}`, { method: "DELETE" });
}

/** F4：生成（或取缓存）一篇 paper 某语言的 markmap 脑图。后端缓存优先。 */
export function mindmap(
  paperId: string,
  opts: { lang?: MindmapLang; force?: boolean } = {},
): Promise<MindmapResult> {
  return req<MindmapResult>(`/paper/${encodeURIComponent(paperId)}/mindmap`, {
    method: "POST",
    body: JSON.stringify({ lang: opts.lang, force: opts.force }),
  });
}

/** 翻译一批 block（缺省整篇未翻；后端单次 cap 35，返 remaining/has_more）。 */
export function translate(
  paperId: string,
  opts: { blockIds?: string[]; force?: boolean } = {},
): Promise<TranslateResult> {
  return req<TranslateResult>(`/paper/${encodeURIComponent(paperId)}/translate`, {
    method: "POST",
    body: JSON.stringify(opts),
  });
}

/**
 * 整篇懒翻编排：后端单次 cap（现 20），循环调用直到 has_more=false。
 * 每批回调用于增量刷新 UI。返回累计翻译数。
 *
 * F3-fix2：批级自动重试。单批撞 gateway_error（平台 502/503/504）/network
 *   → 指数退避重试（默认 3 次）。已翻 block 走缓存不重复翻（force 仅首批），
 *   重试只重提未翻那批。重试仍败才抩 → 招组上抛（onBatch 已增量落盘），
 *   调用方拿 total 报“已翻 X 剩 Y 可重试”而非整篇丢。
 */
export async function translateAll(
  paperId: string,
  onBatch: (r: TranslateResult, totalDone: number) => void,
  opts: { force?: boolean; maxBatches?: number; retriesPerBatch?: number } = {},
): Promise<number> {
  let total = 0;
  // 收口①：fan-out 35→8 后单批变小，大论文（GEPA ~221 block）需更多批 → maxBatches 括到 80
  //   （≤8×80=640 block 上限，足覆盖）。has_more=false 提前终止，不会空转。
  const maxBatches = opts.maxBatches ?? 80;
  const retriesPerBatch = opts.retriesPerBatch ?? 3;
  for (let i = 0; i < maxBatches; i++) {
    // 单批指数退避重试（仅对 gateway/network 可恢复错）。
    let r: TranslateResult | null = null;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retriesPerBatch; attempt++) {
      try {
        r = await translate(paperId, { force: i === 0 && attempt === 0 ? opts.force : false });
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        const recoverable =
          e instanceof ApiError &&
          (e.code === "gateway_error" || e.code === "network" || e.code === "gateway_timeout");
        // 收口④：retryable = 503/502/504(gateway_error)/network/timeout。
        //   429(rate_limited) 不在列 —— 那要看 Retry-After，且后端已在 invocation 内
        //   degradeOnRateLimit 动态减半并发消化；4xx 终态错不重试。
        if (!recoverable || attempt === retriesPerBatch) throw e;
        // 收口②：指数退避 + jitter + 封顶。503 是过载信号，无 jitter 的
        //   同步重试会把多个批对齐到同一时刻二次打爆。封顶 8s 防过长等待。
        const backoff = Math.min(800 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400);
        await new Promise((rsv) => setTimeout(rsv, backoff));
      }
    }
    if (!r) {
      // 理论不可达（throw 已在上面），防御性报。
      throw lastErr ?? new ApiError("翻译中断", 0, "unknown");
    }
    total += r.translated.length;
    onBatch(r, total);
    if (!r.has_more) break;
  }
  return total;
}

// ── F1：批注/笔记（划词记笔记 + 锚定原文 + 书签标识）──
export interface Annotation {
  id: string;
  paper_id: string;
  block_id: string;
  sel_start: number | null;
  sel_end: number | null;
  quote_snapshot: string | null;
  note_md: string;
  created_at: number;
}

export interface AnnotationsResult {
  paper_id: string;
  annotations: Annotation[];
}

/** 取一篇论文的全部批注（按 created_at 升序）。 */
export function listAnnotations(paperId: string): Promise<AnnotationsResult> {
  return req<AnnotationsResult>(`/paper/${encodeURIComponent(paperId)}/annotations`);
}

/** 新建批注：block_id + note_md（+ 可选 quote_snapshot / sel_start / sel_end）。 */
export function createAnnotation(
  paperId: string,
  body: {
    block_id: string;
    note_md: string;
    quote_snapshot?: string | null;
    sel_start?: number | null;
    sel_end?: number | null;
  },
): Promise<{ paper_id: string; annotation: Annotation }> {
  return req<{ paper_id: string; annotation: Annotation }>(
    `/paper/${encodeURIComponent(paperId)}/annotations`,
    { method: "POST", body: JSON.stringify(body) },
  );
}

/** 编辑批注 note_md。 */
export function updateAnnotation(
  paperId: string,
  annotationId: string,
  noteMd: string,
): Promise<{ paper_id: string; annotation: Annotation }> {
  return req<{ paper_id: string; annotation: Annotation }>(
    `/paper/${encodeURIComponent(paperId)}/annotations/${encodeURIComponent(annotationId)}`,
    { method: "PATCH", body: JSON.stringify({ note_md: noteMd }) },
  );
}

/** 删除批注。 */
export function deleteAnnotation(
  paperId: string,
  annotationId: string,
): Promise<{ paper_id: string; id: string; deleted: boolean }> {
  return req<{ paper_id: string; id: string; deleted: boolean }>(
    `/paper/${encodeURIComponent(paperId)}/annotations/${encodeURIComponent(annotationId)}`,
    { method: "DELETE" },
  );
}
