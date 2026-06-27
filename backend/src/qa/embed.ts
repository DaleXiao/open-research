// M5 — embedding 懒生成。
// 首次问全文时为单篇所有 para+heading block 生成向量并写 D1；
// 后续问全文直接读缓存跳过生成。公式/图表（type=math/figure）不进 embedding。

import type { Block } from "../parse/types.js";
import { embed, type GatewayConfig } from "../llm/gateway.js";
import {
  type D1Like,
  getEmbeddings,
  putEmbeddings,
  type StoredEmbedding,
} from "../store/d1.js";

/** text-embedding 默认模型（ 总纲已锁）。 */
export const EMBED_MODEL = "text-embedding-v4";

/** 单次 embeddings 调用的 input 批大小（避免单请求过大）。 */
const EMBED_BATCH = 10;

/** 可进 embedding 的 block：仅 para + heading 且有文本。公式/图表跳过。 */
export function embeddableBlocks(blocks: Block[]): Block[] {
  return blocks.filter(
    (b) =>
      (b.type === "para" || b.type === "heading") &&
      (b.text_en?.trim()?.length ?? 0) > 0,
  );
}

export interface EmbedConfig {
  gateway: GatewayConfig;
  model?: string;
}

/**
 * 确保一篇 paper 的全部 para+heading block 已有 embedding。
 * 已缓存的跳过；仅为缺失 block 调 gateway 生成并写 D1。
 * 返回该 paper 全部 block 向量（含本次新生成 + 已缓存）。
 *
 * lazyGenerated=true 表示本次有新生成（首次问全文）；false 表示全命中缓存。
 */
export async function ensureEmbeddings(
  db: D1Like,
  paperId: string,
  blocks: Block[],
  cfg: EmbedConfig,
): Promise<{ vectors: Map<string, number[]>; lazyGenerated: boolean; dim: number }> {
  const model = cfg.model ?? EMBED_MODEL;
  const targets = embeddableBlocks(blocks);

  const cached = await getEmbeddings(db, paperId);
  const missing = targets.filter((b) => !cached.has(b.id));

  let lazyGenerated = false;
  if (missing.length > 0) {
    lazyGenerated = true;
    for (let i = 0; i < missing.length; i += EMBED_BATCH) {
      const chunk = missing.slice(i, i + EMBED_BATCH);
      const inputs = chunk.map((b) => embedText(b));
      const vecs = await embed(cfg.gateway, model, inputs, "embed");
      const rows = chunk.map((b, j) => ({ block_id: b.id, vector: vecs[j] }));
      await putEmbeddings(db, paperId, model, rows);
      for (const r of rows) {
        cached.set(r.block_id, {
          block_id: r.block_id,
          vector: r.vector,
          dim: r.vector.length,
          model,
        } as StoredEmbedding);
      }
    }
  }

  const vectors = new Map<string, number[]>();
  let dim = 0;
  for (const b of targets) {
    const e = cached.get(b.id);
    if (e) {
      vectors.set(b.id, e.vector);
      dim = e.dim || e.vector.length;
    }
  }
  return { vectors, lazyGenerated, dim };
}

/** embedding 的文本投影：heading 带 section 语境，para 用原文。 */
export function embedText(b: Block): string {
  return b.text_en.trim();
}

/** 用 gateway 为单条 query 文本生成向量。 */
export async function embedQuery(cfg: EmbedConfig, text: string): Promise<number[]> {
  const model = cfg.model ?? EMBED_MODEL;
  const [vec] = await embed(cfg.gateway, model, [text], "embed");
  return vec ?? [];
}
