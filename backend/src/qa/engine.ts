// M5/M5.2 — QA 引擎：拼 prompt + 调 QA 模型（默认 qwen3.7-plus，via gateway /v1/chat/completions）。
// 两种 scope：
//   selection: 选中 block + 前后各 1 block 作 context，回答引用选中 block。
//   full:      RAG top-k=8 block 原文 + section heading 注入 prompt。
// 回答语言跟随当前阅读语言（lang=zh→中文，en→英文）。

import type { Block } from "../parse/types.js";
import { chatCompletion, type GatewayConfig } from "../llm/gateway.js";

/** QA 默认模型（ M5.2 hotfix）。
 * qwen3.7-plus + enable_thinking:false：关掉0 reasoning 回合，响应 ~2.4-4.3s 稳进 30s wall。
 * 历史：M5.2 裸切 qwen3.7-plus（未关 thinking）烧 reasoning_content 30-60s → 502；
 * 后 M5.3 引入 enable_thinking:false 将延迟 10x。 实测：3.7-plus+关 thinking,
 * QA P50~3s/P95~4.3s，远低 30s wall，可安全切回规范模型。
 * env QA_MODEL 优先（未设走此默认），留口子：后续要切 SSE 不用动代码。 */
export const QA_MODEL = "qwen3.7-plus";

/** 问全文 RAG 检索 top-k（先固定）。 */
export const RAG_TOP_K = 8;

export type QaScope = "selection" | "full";
export type QaLang = "zh" | "en";

export interface QaConfig {
  gateway: GatewayConfig;
  model?: string;
}

/** 取选中 block + 前后各 1 block（按 order 邻近）作选区上下文。 */
export function selectionContext(blocks: Block[], blockId: string): Block[] {
  const idx = blocks.findIndex((b) => b.id === blockId);
  if (idx < 0) return [];
  const lo = Math.max(0, idx - 1);
  const hi = Math.min(blocks.length - 1, idx + 1);
  return blocks.slice(lo, hi + 1);
}

function langName(lang: QaLang): string {
  return lang === "zh" ? "中文" : "English";
}

/** 拼一个 block 的 prompt 片段：[block_id|sec] 原文。 */
function blockSnippet(b: Block): string {
  const head = b.type === "heading" ? "§ " : "";
  return `[${b.id}] ${head}${b.text_en.trim()}`;
}

export interface QaPrompt {
  system: string;
  user: string;
  /** prompt 实际纳入的 block id（用于 cited 兜底 + 校验） */
  contextBlockIds: string[];
}

/** 选区问：选中 block + 邻近上下文。 */
export function buildSelectionPrompt(
  contextBlocks: Block[],
  selectedId: string,
  question: string,
  lang: QaLang,
): QaPrompt {
  const ctxText = contextBlocks.map(blockSnippet).join("\n\n");
  const system =
    `你是论文精读助手。基于给定的选中段落及其上下文回答用户问题，` +
    `务必只依据所给文本，不臆造。用${langName(lang)}回答，简洁准确。` +
    `回答末尾另起一行，以 "CITED: " 开头列出你引用到的 block id（逗号分隔）。`;
  const user =
    `选中段落 id=${selectedId}。\n\n上下文：\n${ctxText}\n\n问题：${question}`;
  return {
    system,
    user,
    contextBlockIds: contextBlocks.map((b) => b.id),
  };
}

/** 问全文：RAG top-k block 注入。 */
export function buildFullPrompt(
  retrievedBlocks: Block[],
  question: string,
  lang: QaLang,
): QaPrompt {
  const ctxText = retrievedBlocks.map(blockSnippet).join("\n\n");
  const system =
    `你是论文精读助手。基于检索到的相关段落回答用户关于整篇论文的问题，` +
    `务必只依据所给文本，不臆造；若信息不足请说明。用${langName(lang)}回答，简洁准确。` +
    `回答末尾另起一行，以 "CITED: " 开头列出你引用到的 block id（逗号分隔）。`;
  const user = `相关段落：\n${ctxText}\n\n问题：${question}`;
  return {
    system,
    user,
    contextBlockIds: retrievedBlocks.map((b) => b.id),
  };
}

/** 从回答尾部解析 "CITED: id1, id2"，与 contextBlockIds 取交集（防臆造 id）。 */
export function parseCited(answer: string, contextBlockIds: string[]): { clean: string; cited: string[] } {
  const allow = new Set(contextBlockIds);
  const m = answer.match(/(?:^|\n)\s*CITED\s*[:：]\s*(.+)\s*$/i);
  let cited: string[] = [];
  let clean = answer;
  if (m) {
    cited = m[1]
      .split(/[,，\s]+/)
      .map((s) => s.trim().replace(/^\[|\]$/g, ""))
      .filter((s) => s.length > 0 && allow.has(s));
    clean = answer.slice(0, m.index).trimEnd();
  }
  return { clean, cited };
}

/** 调 QA 模型回答。返回净答案 + 模型自报的 cited（仅作信号，非权威来源）。 */
export async function answer(
  cfg: QaConfig,
  prompt: QaPrompt,
): Promise<{ answer: string; model_cited: string[]; model: string }> {
  const model = cfg.model ?? QA_MODEL;
  const raw = await chatCompletion(cfg.gateway, {
    model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    temperature: 0.3,
    // M5.3 latency：qwen3.7-plus 默认开 thinking，烧 reasoning
    // tokens → live 30-60s 撞 wall。enable_thinking:false 将延迟 10x（ 实测 QA ~3s）且
    // 答案质量无明显降级。max_tokens=800 作安全网（正常答 text_tokens 仅 120-170 « 800，
    // 不截断）。gateway OpenAI 兼容透传，两参原样转发到 dashscope。
    enable_thinking: false,
    max_tokens: 800,
  }, "qa");
  const { clean, cited } = parseCited(raw, prompt.contextBlockIds);
  return { answer: clean, model_cited: cited, model };
}

/**
 * cited 回填（ M5.1）：cited 权威来源 = 检索层，非生成层。
 * authoritative：检索/选区实际命中的 block ids（selection=选中 block；full=top-k 命中）。
 * modelCited：模型自报的（只取 ∈ authoritative 的部分作“优先高亮”排序）。
 * 返回：model 命中的排前 + 其余 authoritative，去重；保证非空且 ⊆ authoritative。
 */
export function backfillCited(
  authoritative: string[],
  modelCited: string[],
): string[] {
  const allow = new Set(authoritative);
  const highlighted = modelCited.filter((id) => allow.has(id));
  const hiSet = new Set(highlighted);
  const rest = authoritative.filter((id) => !hiSet.has(id));
  const out: string[] = [];
  const seen = new Set<string>();
  for (const id of [...highlighted, ...rest]) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
