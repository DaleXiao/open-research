// iter2 F4 — 思维导图引擎：toc + section 精华 → markmap markdown。
// 复用 M5 QA 的 LLM 调用模式（qwen3.7-plus + enable_thinking:false，via gateway /v1/chat/completions）。
// 不灌全文：只注入章节树（toc）+ 每个 section 首段/abstract 精华，控 token。

import type { Block, ParsedPaper, SectionNode } from "../parse/types.js";
import { chatCompletion, type GatewayConfig } from "../llm/gateway.js";

/** 脑图默认模型。：qwen3.7-plus + enable_thinking:false，响应 P50~5s/P95~11.5s 稳进 30s wall。 */
export const MINDMAP_MODEL = "qwen3.7-plus";

/** 脑图生成 max_tokens。：2000→实测 P95~21s 撞 wall风险；实际输出仅 ~160-215 tokens，
 * 降到 1200 + 精简 prompt 后 P50~5s/P95~11.5s，远低 30s wall。 */
export const MINDMAP_MAX_TOKENS = 1200;

export type MindmapLang = "zh" | "en";

export interface MindmapConfig {
  gateway: GatewayConfig;
  model?: string;
}

function langName(lang: MindmapLang): string {
  return lang === "zh" ? "中文" : "English";
}

/** 把 toc 章节树拍平成带缩进的提纲文本（深度 → 缩进），供 prompt 注入。 */
export function tocOutline(toc: SectionNode[], depth = 0): string {
  const lines: string[] = [];
  for (const node of toc) {
    const indent = "  ".repeat(depth);
    lines.push(`${indent}- [${node.id}] ${node.title.trim()}`);
    if (node.children?.length) {
      lines.push(tocOutline(node.children, depth + 1));
    }
  }
  return lines.filter(Boolean).join("\n");
}

/**
 * 每个 section 取首个正文 para 作精华（控 token）。返回 [sec_id] → snippet。
 * lang=zh 优先用已翻中文（text_zh），无则回退英文；lang=en 用英文。
 */
export function sectionEssence(
  blocks: Block[],
  lang: MindmapLang,
  maxCharsPerSection = 300,
): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const b of blocks) {
    if (b.type !== "para") continue;
    if (!b.sec || seen.has(b.sec)) continue;
    const text = lang === "zh" ? b.text_zh || b.text_en : b.text_en;
    if (!text || !text.trim()) continue;
    seen.add(b.sec);
    lines.push(`[${b.sec}] ${text.trim().slice(0, maxCharsPerSection)}`);
  }
  return lines.join("\n\n");
}

export interface MindmapPrompt {
  system: string;
  user: string;
}

/** 拼脑图 prompt：注入 title + abstract + toc 提纲 + section 精华。 */
export function buildMindmapPrompt(
  paper: ParsedPaper,
  lang: MindmapLang,
): MindmapPrompt {
  const outline = tocOutline(paper.toc);
  const essence = sectionEssence(paper.blocks, lang);
  const abstract = (paper.abstract ?? "").trim().slice(0, 600);
  const system =
    `你是论文结构化助手。基于给定论文的标题、摘要、章节树与各章节精华，` +
    `产出一张层级化的「思维导图」，用 markmap 兼容的 Markdown 语法表达：` +
    `第一行用 "# " 作根节点（论文主题/标题）；章节用 "## "、"### " 逐级展开；` +
    `每个要点用 "- " 列出，**每个节点凝练≤12 字**，信息密度高，覆盖核心贡献/方法/结论；` +
    `控制总体规模，只保留最重要的层级与要点，不贘余。` +
    `若某要点对应某章节，可在要点末尾附 "[章节id]"（如 [S3]）以便跳转，非必须。` +
    `只输出 markmap markdown 本体，不要代码围栏、不要额外说明。用${langName(lang)}书写。`;
  const user =
    `论文标题：${paper.title}\n\n` +
    (abstract ? `摘要：${abstract}\n\n` : "") +
    `章节树：\n${outline || "(无)"}\n\n` +
    `各章节精华：\n${essence || "(无)"}\n\n` +
    `请产出层级化 markmap 思维导图。`;
  return { system, user };
}

/** 去掉模型可能误加的 ```markdown 围栏，保证返回纯 markmap md。 */
export function stripCodeFence(s: string): string {
  let out = s.trim();
  const fence = out.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  if (fence) out = fence[1].trim();
  return out;
}

/** 调 LLM 生成脑图 markdown。返回 { markmap_md, model }。 */
export async function generateMindmap(
  cfg: MindmapConfig,
  paper: ParsedPaper,
  lang: MindmapLang,
): Promise<{ markmap_md: string; model: string }> {
  const model = cfg.model ?? MINDMAP_MODEL;
  const prompt = buildMindmapPrompt(paper, lang);
  const raw = await chatCompletion(cfg.gateway, {
    model,
    messages: [
      { role: "system", content: prompt.system },
      { role: "user", content: prompt.user },
    ],
    temperature: 0.4,
    // 沿用 M5.3：qwen3.6 系默认开 thinking 烧 reasoning tokens → 慢。关掉提速 10x。
    enable_thinking: false,
    max_tokens: MINDMAP_MAX_TOKENS,
  }, "mindmap");
  let md = stripCodeFence(raw);
  // 兜底：模型偶尔不给根节点 "# "，补一个用标题。
  if (!/^#\s/m.test(md)) {
    md = `# ${paper.title}\n\n${md}`;
  }
  return { markmap_md: md, model };
}
