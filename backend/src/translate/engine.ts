// M2 翻译引擎：懒翻单个 block。
// 流程：translate=false 直接跳过；para/heading → maskInlineMath → qwen-mt(per-para 纯文本) →
//       unmaskInlineMath；哨兵还原不全 → translateBySplit 降级（公式 100% 不坏）。
// qwen-mt 用 translation_options 指定 en→zh，纯文本 per-para（绕开混合文本弱点，公式已被 mask）。

import type { Block } from "../parse/types.js";
import { chatCompletion, type GatewayConfig } from "../llm/gateway.js";
import {
  maskInlineMath,
  unmaskInlineMath,
  translateBySplit,
} from "./mask.js";

/** qwen-mt 系列模型名（落地前 curl gateway 验活；默认 turbo）。 */
export const QWEN_MT_MODEL = "qwen-mt-turbo";

export interface TranslateConfig {
  gateway: GatewayConfig;
  model?: string;
  sourceLang?: string;
  targetLang?: string;
}

export interface BlockTranslation {
  block_id: string;
  text_zh: string;
  model: string;
  /** 是否走了降级分段翻译路径 */
  degraded: boolean;
}

/** 对单段纯文本（已 mask 公式）调 qwen-mt en→zh。 */
async function mtTranslate(
  text: string,
  cfg: TranslateConfig,
): Promise<string> {
  const model = cfg.model ?? QWEN_MT_MODEL;
  const out = await chatCompletion(cfg.gateway, {
    model,
    messages: [{ role: "user", content: text }],
    translation_options: {
      source_lang: cfg.sourceLang ?? "English",
      target_lang: cfg.targetLang ?? "Chinese",
    },
  }, "translate");
  return out.trim();
}

/**
 * 翻译单个 block。translate=false（公式/图表）直接返回 null（不送翻）。
 * 返回 null 表示该 block 无需翻译。
 */
export async function translateBlock(
  block: Block,
  cfg: TranslateConfig,
): Promise<BlockTranslation | null> {
  if (!block.translate) return null;
  const src = block.text_en?.trim();
  if (!src) return null;

  const model = cfg.model ?? QWEN_MT_MODEL;
  const { masked, hasMath } = maskInlineMath(src);

  if (!hasMath) {
    // 无行内公式：直接整段翻
    const zh = await mtTranslate(masked, cfg);
    return { block_id: block.id, text_zh: zh, model, degraded: false };
  }

  // 含行内公式：mask → 翻 → unmask，校验哨兵完整
  const { formulas } = maskInlineMath(src);
  const translated = await mtTranslate(masked, cfg);
  const restored = unmaskInlineMath(translated, formulas);
  if (restored.ok) {
    return { block_id: block.id, text_zh: restored.text, model, degraded: false };
  }

  // 降级：哨兵被 MT 改/丢 → 分段翻，公式原样拼回（保证公式不坏）
  const zh = await translateBySplit(src, (prose) => mtTranslate(prose, cfg));
  return { block_id: block.id, text_zh: zh, model, degraded: true };
}

/** 批量翻译一组 block（带并发上限），跳过 translate=false。 */
export async function translateBlocks(
  blocks: Block[],
  cfg: TranslateConfig,
  opts: { concurrency?: number } = {},
): Promise<BlockTranslation[]> {
  const todo = blocks.filter((b) => b.translate && (b.text_en?.trim()?.length ?? 0) > 0);
  const concurrency = Math.max(1, opts.concurrency ?? 4);
  const results: BlockTranslation[] = [];
  let cursor = 0;

  async function worker() {
    while (cursor < todo.length) {
      const i = cursor++;
      const tr = await translateBlock(todo[i], cfg);
      if (tr) results.push(tr);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, todo.length) }, () => worker()),
  );
  // 保持 block 顺序
  const order = new Map(todo.map((b, i) => [b.id, i]));
  results.sort((a, b) => (order.get(a.block_id)! - order.get(b.block_id)!));
  return results;
}
