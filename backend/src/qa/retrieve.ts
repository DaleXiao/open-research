// M5 — RAG 检索：worker 内存余弦相似度 top-k。
// 单篇 ≤150 block，暴力余弦无压力（D1 不支持 sqlite-vec，单篇够用）。

export function cosineSim(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

export interface Scored {
  block_id: string;
  score: number;
}

/**
 * 对 query 向量在候选 block 向量集中检索 top-k。
 * candidates: Map<block_id, vector>。返回按 score 降序的 top-k block_id + 分数。
 */
export function topK(
  queryVec: number[],
  candidates: Map<string, number[]>,
  k: number,
): Scored[] {
  const scored: Scored[] = [];
  for (const [block_id, vec] of candidates) {
    scored.push({ block_id, score: cosineSim(queryVec, vec) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(0, k));
}
