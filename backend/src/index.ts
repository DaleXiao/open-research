// research.example.com Worker 入口（ M2 对照阅读）。
// 路由：
//   POST /api/import           { url|id }            → 解析+落地，返回 paper_id + meta
//   GET  /api/paper/:id        → 对照视图（blocks + 已缓存中文）
//   POST /api/paper/:id/translate { blockIds?, force? } → 懒翻（缓存优先），返回新译 + 命中数
//   GET  /api/health           → ok
// LLM 全走 api-llm.example.com（service=research）；公式/图表不送翻。

import type { ServiceCtx } from "./service.js";
import { saveClientPaper, getView, translatePaper, askPaper, mindmapPaper, listQa, listPapersView, deletePaperView, createAnnotation, listAnnotationsView, editAnnotation, removeAnnotation, ImportValidationError, type ClientPaperPayload, QaError, AnnotationError } from "./service.js";
import { checkAuth, type AuthEnv } from "./auth.js";
import { GatewayError } from "./llm/gateway.js";
import { QWEN_MT_MODEL } from "./translate/engine.js";
import { QA_MODEL } from "./qa/engine.js";
import { EMBED_MODEL } from "./qa/embed.js";

export interface Env {
  DB: D1Database;
  /** api-llm.example.com */
  LLM_GATEWAY_URL: string;
  /** SERVICE_TOKEN_RESEARCH（wrangler secret） */
  SERVICE_TOKEN_RESEARCH: string;
  /** 可选覆盖翻译模型 */
  QWEN_MT_MODEL?: string;
  /** M5：可选覆盖 QA 模型（默认 qwen3.7-plus） */
  QA_MODEL?: string;
  /** M5：可选覆盖 embedding 模型（默认 text-embedding-v4） */
  EMBED_MODEL?: string;
  /** CORS 允许来源，默认 research.example.com */
  CORS_ORIGIN?: string;
  /**
   * api-llm-worker service binding（同账号同 zone）。
   * 可选：wrangler dev / 单测无 binding 时为 undefined，gateway 自动 fallback public fetch。
   * binding present 时 Worker→gateway 走 CF runtime 内路由，绕开 public edge 的 522。
   */
  API_LLM?: Fetcher;
  /** 入口鉴权（防 API 白嫖）。wrangler secret，与 Pages 同值。 */
  USERS_JSON?: string;
  SESSION_SECRET?: string;
}

function ctxFromEnv(env: Env): ServiceCtx {
  const gateway = {
    baseUrl: env.LLM_GATEWAY_URL || "https://api-llm.example.com",
    token: env.SERVICE_TOKEN_RESEARCH,
    fetchImpl: resolveLlmFetch(env.API_LLM),
    // M5.2 hotfix：显式 90s（慢响应 buffer，仍在 CF Pages 100s 边缘窗内）
    timeoutMs: 90000,
  };
  return {
    db: env.DB as any,
    translate: {
      gateway,
      model: env.QWEN_MT_MODEL || QWEN_MT_MODEL,
      sourceLang: "English",
      targetLang: "Chinese",
    },
    // M5 QA：qwen3.7-plus chat(, enable_thinking:false) + text-embedding-v4，同走 gateway
    qa: {
      gateway,
      qaModel: env.QA_MODEL || QA_MODEL,
      embedModel: env.EMBED_MODEL || EMBED_MODEL,
    },
  };
}

/**
 * binding present → 用 binding.fetch 作为 gateway 客户端 fetchImpl
 * （CF 按 binding name 路由，URL host 被忽略但原样转发保 path/日志一致）；
 * 否则返 undefined → gateway fallback 到全局 fetch(public URL)。
 *
 * ⚠️ ：必须把 (url, init) 显式包成 Request 再交给 binding.fetch。
 * 直接传 (urlString, init) 两参时，CF Service Binding 子请求会丢 init.headers
 * （Authorization 没进 wire → api-llm 收不到 token → 401 unknown-token）。
 * 包成 Request 后 headers 随 Request 进入 binding 子请求，鉴权正常。
 */
export function resolveLlmFetch(binding: Fetcher | undefined): typeof fetch | undefined {
  if (!binding) return undefined;
  return ((input: any, init?: any) =>
    binding.fetch(new Request(input, init))) as typeof fetch;
}

function cors(env: Env): Record<string, string> {
  return {
    "access-control-allow-origin": env.CORS_ORIGIN || "*",
    "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function json(data: unknown, status: number, env: Env): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...cors(env) },
  });
}

function errStatus(e: unknown): number {
  if (e instanceof ImportValidationError) return 400;
  if (e instanceof QaError) {
    return e.code === "qa_unconfigured" ? 503 : 400;
  }
  if (e instanceof AnnotationError) {
    return e.code === "annotation_not_found" ? 404 : 400;
  }
  if (e instanceof GatewayError) return e.status >= 400 ? 502 : 503;
  return 500;
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;

    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors(env) });
    }

    if (pathname === "/api/health") {
      return json({ ok: true, service: "research-worker", milestone: "M5" }, 200, env);
    }

    // 鉴权门禁（防 API 白嫖）。OPTIONS（CORS 预检）+ /api/health 之后、
    // 所有业务路由之前。fail-closed：缺 secret → 503；无有效 cookie/Basic → 401。
    const denied = await checkAuth(req, env as AuthEnv);
    if (denied) {
      // 401/503 也带 CORS 头，浏览器同源 fetch 能读到状态。
      for (const [k, v] of Object.entries(cors(env))) denied.headers.set(k, v);
      return denied;
    }

    try {
      const ctx = ctxFromEnv(env);

      // F2: GET /api/papers?limit=30 → 倒序导入列表（进站恢复）。
      // 注意放在 /api/paper/:id 正则之前（papers 不会撑 paper/:id，但语义上先命中更明确）。
      if (pathname === "/api/papers" && req.method === "GET") {
        const limitParam = url.searchParams.get("limit");
        const limit = limitParam ? parseInt(limitParam, 10) : undefined;
        const papers = await listPapersView(ctx, Number.isFinite(limit as number) ? limit : undefined);
        return json({ papers }, 200, env);
      }

      // POST /api/import
      // 接收「前端已解析」的 blocks，worker 零解析零 fetch arxiv，只校验+落库。
      // 解析在用户浏览器跑（用户 CPU，无 isolate CPU 墙）→ 根除 1102。
      if (pathname === "/api/import" && req.method === "POST") {
        const body = await req.json<ClientPaperPayload & { force?: boolean }>();
        const { paper_id, paper, cached } = await saveClientPaper(ctx, body, {
          force: body.force,
        });
        return json(
          {
            paper_id,
            status: "ready",
            cached,
            title: paper.title,
            arxiv_id: paper.arxiv_id,
            source_type: paper.source_type,
            block_count: paper.blocks.length,
            toc: paper.toc,
          },
          200,
          env,
        );
      }

      // /api/paper/:id  和  /api/paper/:id/translate
      const m = pathname.match(/^\/api\/paper\/([^/]+)(\/translate)?$/);
      if (m) {
        const paperId = decodeURIComponent(m[1]);
        const isTranslate = !!m[2];

        if (!isTranslate && req.method === "GET") {
          const view = await getView(ctx, paperId);
          if (!view) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json(view, 200, env);
        }

        // F5: DELETE /api/paper/:id → 级联删除（papers + 派生各表）。
        if (!isTranslate && req.method === "DELETE") {
          const res = await deletePaperView(ctx, paperId);
          if (!res) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, deleted: res }, 200, env);
        }

        if (isTranslate && req.method === "POST") {
          const body = await req
            .json<{ blockIds?: string[]; force?: boolean; concurrency?: number }>()
            .catch(() => ({}) as { blockIds?: string[]; force?: boolean; concurrency?: number });
          const res = await translatePaper(ctx, paperId, {
            blockIds: body.blockIds,
            force: body.force,
            concurrency: body.concurrency,
          });
          if (!res) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json(res, 200, env);
        }
      }

      // M5 QA：POST /api/paper/:id/qa（问）+ GET /api/paper/:id/qa（历史）
      const qaM = pathname.match(/^\/api\/paper\/([^/]+)\/qa$/);
      if (qaM) {
        const paperId = decodeURIComponent(qaM[1]);
        if (req.method === "GET") {
          const list = await listQa(ctx, paperId);
          if (!list) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, history: list }, 200, env);
        }
        if (req.method === "POST") {
          const body = await req
            .json<{ scope?: string; block_id?: string; question?: string; lang?: string }>()
            .catch(() => ({}) as Record<string, string>);
          const scope = body.scope === "full" ? "full" : "selection";
          const lang = body.lang === "en" ? "en" : "zh";
          if (!body.question || !body.question.trim()) {
            return json({ error: "缺 question" }, 400, env);
          }
          const res = await askPaper(ctx, paperId, {
            scope,
            question: body.question,
            lang,
            block_id: body.block_id,
          });
          if (!res) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json(res, 200, env);
        }
      }

      // F4 思维导图：POST /api/paper/:id/mindmap { lang?, force? } → { markmap_md, model, lang, cached }
      const mindmapM = pathname.match(/^\/api\/paper\/([^/]+)\/mindmap$/);
      if (mindmapM && req.method === "POST") {
        const paperId = decodeURIComponent(mindmapM[1]);
        const body = await req
          .json<{ lang?: string; force?: boolean }>()
          .catch(() => ({}) as Record<string, unknown>);
        const lang = body.lang === "en" ? "en" : "zh";
        const res = await mindmapPaper(ctx, paperId, { lang, force: !!body.force });
        if (!res) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
        return json(res, 200, env);
      }

      // F1 批注：
      //   GET    /api/paper/:id/annotations          → 列表（created_at ASC）
      //   POST   /api/paper/:id/annotations          → 新建 { block_id, note_md, quote_snapshot?, sel_start?, sel_end? }
      //   PATCH  /api/paper/:id/annotations/:aid      → 编辑 { note_md }
      //   DELETE /api/paper/:id/annotations/:aid      → 删除
      const annColl = pathname.match(/^\/api\/paper\/([^/]+)\/annotations$/);
      if (annColl) {
        const paperId = decodeURIComponent(annColl[1]);
        if (req.method === "GET") {
          const list = await listAnnotationsView(ctx, paperId);
          if (!list) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, annotations: list }, 200, env);
        }
        if (req.method === "POST") {
          type AnnBody = {
            block_id?: string;
            note_md?: string;
            quote_snapshot?: string | null;
            sel_start?: number | null;
            sel_end?: number | null;
          };
          const body = await req.json<AnnBody>().catch(() => ({}) as AnnBody);
          if (!body.block_id) return json({ error: "缺 block_id" }, 400, env);
          const rec = await createAnnotation(ctx, paperId, {
            block_id: body.block_id,
            note_md: body.note_md ?? "",
            quote_snapshot: body.quote_snapshot ?? null,
            sel_start: body.sel_start ?? null,
            sel_end: body.sel_end ?? null,
          });
          if (!rec) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, annotation: rec }, 200, env);
        }
      }

      const annItem = pathname.match(/^\/api\/paper\/([^/]+)\/annotations\/([^/]+)$/);
      if (annItem) {
        const paperId = decodeURIComponent(annItem[1]);
        const aid = decodeURIComponent(annItem[2]);
        if (req.method === "PATCH") {
          const body = await req
            .json<{ note_md?: string }>()
            .catch(() => ({}) as { note_md?: string });
          if (body.note_md === undefined) return json({ error: "缺 note_md" }, 400, env);
          const rec = await editAnnotation(ctx, paperId, aid, body.note_md);
          if (!rec) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, annotation: rec }, 200, env);
        }
        if (req.method === "DELETE") {
          const ok = await removeAnnotation(ctx, paperId, aid);
          if (!ok) return json({ error: "paper 未导入", paper_id: paperId }, 404, env);
          return json({ paper_id: paperId, id: aid, deleted: true }, 200, env);
        }
      }

      return json({ error: "not found", path: pathname }, 404, env);
    } catch (e) {
      const status = errStatus(e);
      const code = (e as any)?.code ?? "internal";
      console.log(
        JSON.stringify({ err: String(e), code, status, path: pathname }),
      );
      return json({ error: String((e as any)?.message ?? e), code }, status, env);
    }
  },
};
