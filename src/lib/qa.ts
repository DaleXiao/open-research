// research-worker 后端 API 契约（M5 「AI 问 paper」）。
// 同源 fetch 相对 /api，沿用 api.ts 的 ApiError + req 封装风格。
// 后端：POST /api/paper/:id/qa（提问）/ GET /api/paper/:id/qa（历史）。

export type QaScope = "selection" | "full";
export type QaLang = "zh" | "en";

export interface QaAnswer {
  answer: string;
  cited_block_ids: string[];
  model: string;
  scope: QaScope;
  embeddings_generated?: number;
}

export interface QaRecord {
  id: string;
  paper_id: string;
  scope: QaScope;
  question: string;
  answer: string;
  cited_block_ids: string[];
  created_at: string;
}

export interface QaHistory {
  paper_id: string;
  history: QaRecord[];
}

export interface AskOpts {
  scope: QaScope;
  block_id?: string;
  question: string;
  lang: QaLang;
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
  // M5.2：显式 90s AbortController（与后端对齐），超时抛 gateway_timeout。
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90000);
  try {
    res = await fetch(BASE + path, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", ...(init?.headers || {}) },
    });
  } catch (e) {
    if ((e as any)?.name === "AbortError") {
      throw new ApiError("提问超时", 0, "gateway_timeout");
    }
    throw new ApiError(`网络错误：${String(e)}`, 0, "network");
  } finally {
    clearTimeout(timer);
  }
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // M5.2：502/504 边缘超时返 HTML 错误页 → 非 JSON。按状态码分级为 gateway 错误。
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError(`服务暂不可用（HTTP ${res.status}）`, res.status, "gateway_error");
    }
    throw new ApiError(`后端返回非 JSON（HTTP ${res.status}）`, res.status, "bad_json");
  }
  if (!res.ok) {
    // M5.2：后端返了 JSON 但 5xx → gateway 错误分级
    if (res.status === 502 || res.status === 503 || res.status === 504) {
      throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, "gateway_error");
    }
    throw new ApiError(body?.error || `HTTP ${res.status}`, res.status, body?.code);
  }
  return body as T;
}

/** 向论文提问。scope=selection 时必须带 block_id；scope=full 不带。 */
export function askPaper(paperId: string, opts: AskOpts): Promise<QaAnswer> {
  const payload: AskOpts = {
    scope: opts.scope,
    question: opts.question,
    lang: opts.lang,
  };
  if (opts.scope === "selection" && opts.block_id) payload.block_id = opts.block_id;
  return req<QaAnswer>(`/paper/${encodeURIComponent(paperId)}/qa`, {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

/** 取该论文的问答历史（按后端返回顺序）。 */
export function listQa(paperId: string): Promise<QaHistory> {
  return req<QaHistory>(`/paper/${encodeURIComponent(paperId)}/qa`);
}
