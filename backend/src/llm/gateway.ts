// LLM API Gateway 客户端：所有 LLM 调用走 api-llm.example.com（service=research），
// 不直连 Dashscope。复用 gateway 的鉴权 / 限流 / D1 计数 / 告警（ M0）。

export interface GatewayConfig {
  /** 网关基址，如 https://api-llm.example.com */
  baseUrl: string;
  /** SERVICE_TOKEN_RESEARCH */
  token: string;
  /** 注入 fetch（测试用），默认全局 fetch */
  fetchImpl?: typeof fetch;
  /** 单次超时 ms */
  timeoutMs?: number;
  /**
   * 瞬时错误重试上限（429 / 5xx / 网络 / 超时）。默认 3。0 = 不重试。
   * M5.4：qwen-mt 并发翻译易撞限流 429，单次失败不应直接放弃该 block。
   */
  maxRetries?: number;
  /** 重试基准退避 ms（指数 + 抖动），默认 500。Retry-After 头优先。 */
  retryBaseMs?: number;
  /** 注入 sleep（测试用），默认 setTimeout。 */
  sleepImpl?: (ms: number) => Promise<void>;
}

export class GatewayError extends Error {
  status: number;
  code: string;
  /** 是否为可重试的瞬时错误（429 / 5xx / 网络 / 超时）。 */
  retryable: boolean;
  /** 是否为限流（429）——上层据此降并发。 */
  rateLimited: boolean;
  /** Retry-After 解析出的建议等待 ms（429/503 时可能有）。 */
  retryAfterMs?: number;
  constructor(
    message: string,
    status: number,
    code: string,
    extra?: { retryable?: boolean; rateLimited?: boolean; retryAfterMs?: number },
  ) {
    super(message);
    this.name = "GatewayError";
    this.status = status;
    this.code = code;
    this.rateLimited = extra?.rateLimited ?? status === 429;
    // 默认：429 + 5xx + 网络/超时(status=0) 视为可重试
    this.retryable =
      extra?.retryable ?? (status === 429 || status >= 500 || status === 0);
    this.retryAfterMs = extra?.retryAfterMs;
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((r) => setTimeout(r, ms));

/** 解析 Retry-After 头（秒数或 HTTP-date）→ ms；解析不出返回 undefined。 */
function parseRetryAfter(res: Response): number | undefined {
  const h = res.headers.get("retry-after");
  if (!h) return undefined;
  const secs = Number(h);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const when = Date.parse(h);
  if (Number.isFinite(when)) return Math.max(0, when - Date.now());
  return undefined;
}

/**
 * 瞬时错误重试包装：仅对 GatewayError.retryable 重试，退避 = max(Retry-After, 指数+抖动)。
 * 非可重试错误（4xx 非 429、bad_json 等）立即抛出。复用于 chat + embeddings。
 */
async function withRetry<T>(
  cfg: GatewayConfig,
  fn: () => Promise<T>,
): Promise<T> {
  const maxRetries = Math.max(0, cfg.maxRetries ?? 3);
  const baseMs = Math.max(1, cfg.retryBaseMs ?? 500);
  const sleep = cfg.sleepImpl ?? defaultSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (e) {
      const ge = e instanceof GatewayError ? e : null;
      if (!ge || !ge.retryable || attempt >= maxRetries) throw e;
      attempt++;
      // 退避：Retry-After 优先；否则指数(base*2^(n-1)) + 0..base 抖动，封顶 30s。
      const backoff = baseMs * 2 ** (attempt - 1) + Math.floor(Math.random() * baseMs);
      const waitMs = Math.min(30_000, Math.max(ge.retryAfterMs ?? 0, backoff));
      await sleep(waitMs);
    }
  }
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatOpts {
  model: string;
  messages: ChatMessage[];
  /** qwen-mt 专用：{ source_lang, target_lang, terms? } */
  translation_options?: Record<string, unknown>;
  temperature?: number;
  [k: string]: unknown;
}

/** POST /v1/chat/completions，返回 choices[0].message.content。含瞬时错误重试（429/5xx）。 */
export async function chatCompletion(
  cfg: GatewayConfig,
  opts: ChatOpts,
  usecase?: string,
): Promise<string> {
  return withRetry(cfg, () => chatCompletionOnce(cfg, opts, usecase));
}

/** 单次 chat 调用（不重试）；withRetry 包在外层。 */
async function chatCompletionOnce(
  cfg: GatewayConfig,
  opts: ChatOpts,
  usecase?: string,
): Promise<string> {
  const f = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 90000);
  // 迁移#7：caller 传 usecase → x-llm-usecase header，网关自动发现场景
  // （不设 override 时 body 不变，行为 100% = 当前实际）。未传则 header 不出现。
  // ⚠️ usecase 走 header 而非 body：opts 整体即请求 body，塞进 body 会污染上游。
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.token}`,
    "content-type": "application/json",
  };
  if (usecase) headers["x-llm-usecase"] = usecase;
  let res: Response;
  try {
    res = await f(`${cfg.baseUrl.replace(/\/$/, "")}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(opts),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as any)?.name === "AbortError") {
      throw new GatewayError(`gateway 超时`, 0, "timeout");
    }
    throw new GatewayError(`gateway fetch 失败：${String(e)}`, 0, "fetch_failed");
  } finally {
    clearTimeout(t);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new GatewayError(
      `gateway HTTP ${res.status}：${bodyText.slice(0, 300)}`,
      res.status,
      res.status === 401
        ? "unauthorized"
        : res.status === 429
          ? "rate_limited"
          : "upstream_error",
      res.status === 429 || res.status === 503
        ? { retryAfterMs: parseRetryAfter(res) }
        : undefined,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new GatewayError(`gateway 返回非 JSON：${bodyText.slice(0, 200)}`, res.status, "bad_json");
  }
  const content = parsed?.choices?.[0]?.message?.content;
  if (typeof content !== "string") {
    throw new GatewayError(
      `gateway 响应缺 choices[0].message.content`,
      res.status,
      "no_content",
    );
  }
  return content;
}

/**
 * POST /v1/embeddings（ M5）。text-embedding-v4，OpenAI 兼容透传。
 * input 可单条或批量；返回与 input 等长、保序的向量数组。
 */
export async function embed(
  cfg: GatewayConfig,
  model: string,
  input: string[],
  usecase?: string,
): Promise<number[][]> {
  if (input.length === 0) return [];
  return withRetry(cfg, () => embedOnce(cfg, model, input, usecase));
}

/** 单次 embeddings 调用（不重试）；withRetry 包在外层。 */
async function embedOnce(
  cfg: GatewayConfig,
  model: string,
  input: string[],
  usecase?: string,
): Promise<number[][]> {
  const f = cfg.fetchImpl ?? fetch;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 90000);
  // 迁移#7：caller 传 usecase → x-llm-usecase header。未传则 header 不出现。
  const headers: Record<string, string> = {
    authorization: `Bearer ${cfg.token}`,
    "content-type": "application/json",
  };
  if (usecase) headers["x-llm-usecase"] = usecase;
  let res: Response;
  try {
    res = await f(`${cfg.baseUrl.replace(/\/$/, "")}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model, input }),
      signal: ctrl.signal,
    });
  } catch (e) {
    if ((e as any)?.name === "AbortError") {
      throw new GatewayError(`gateway embeddings 超时`, 0, "timeout");
    }
    throw new GatewayError(`gateway embeddings fetch 失败：${String(e)}`, 0, "fetch_failed");
  } finally {
    clearTimeout(t);
  }

  const bodyText = await res.text();
  if (!res.ok) {
    throw new GatewayError(
      `gateway embeddings HTTP ${res.status}：${bodyText.slice(0, 300)}`,
      res.status,
      res.status === 401
        ? "unauthorized"
        : res.status === 429
          ? "rate_limited"
          : "upstream_error",
      res.status === 429 || res.status === 503
        ? { retryAfterMs: parseRetryAfter(res) }
        : undefined,
    );
  }

  let parsed: any;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    throw new GatewayError(`gateway embeddings 返回非 JSON：${bodyText.slice(0, 200)}`, res.status, "bad_json");
  }
  const data = parsed?.data;
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new GatewayError(
      `gateway embeddings 返回 data 长度不符（want ${input.length} got ${Array.isArray(data) ? data.length : "n/a"}）`,
      res.status,
      "bad_shape",
    );
  }
  // 按 index 保序（OpenAI 兼容返回带 index）
  const out: number[][] = new Array(input.length);
  for (let i = 0; i < data.length; i++) {
    const item = data[i];
    const idx = typeof item?.index === "number" ? item.index : i;
    const vec = item?.embedding;
    if (!Array.isArray(vec)) {
      throw new GatewayError(`gateway embeddings data[${i}] 缺 embedding 数组`, res.status, "no_vector");
    }
    out[idx] = vec as number[];
  }
  return out;
}
