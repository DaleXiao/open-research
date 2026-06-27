// 中英对照渲染投影：把 blocks[] + 翻译缓存 合成前端可直接渲染的对照视图。
// 公式（math）/图表（figure）原样带 latex/img_url，不掺中文（translate=false）。
// "一篇可读，公式不坏" 的渲染契约在此固化。

import type { Block, ParsedPaper, SectionNode } from "../parse/types.js";
import type { CachedTranslation } from "../store/d1.js";

export interface BilingualBlock {
  id: string;
  type: Block["type"];
  sec: string;
  order: number;
  level: number;
  /** 英文原文（para/heading），公式块为 "" */
  text_en: string;
  /** 中文译文：未翻或不送翻为 null */
  text_zh: string | null;
  /** math 块 LaTeX */
  latex: string | null;
  img_url: string | null;
  caption: string | null;
  anchor: string;
  /** 是否可翻（公式/图表 false） */
  translate: boolean;
  /** 翻译状态：none(不送翻) | pending(可翻未翻) | done */
  zh_status: "none" | "pending" | "done";
}

export interface BilingualView {
  paper_id: string;
  /** 解析状态机。ready=可渲染；parsing=解析中（前端继续轮询）；failed=失败。 */
  /** client-parse 后 worker 只返 ready（解析在客户端，落库即就绪）。 */
  status: "ready";
  title: string;
  arxiv_id: string | null;
  source_url: string;
  toc: SectionNode[];
  blocks: BilingualBlock[];
  stats: {
    total: number;
    translatable: number;
    translated: number;
  };
}

/** 合成对照视图。translations 缺失的可翻 block 标 pending，前端可懒触发翻译。 */
export function buildBilingualView(
  paperId: string,
  paper: ParsedPaper,
  translations: Map<string, CachedTranslation>,
): BilingualView {
  let translatable = 0;
  let translated = 0;
  const blocks: BilingualBlock[] = paper.blocks.map((b) => {
    const cached = translations.get(b.id);
    let zh_status: BilingualBlock["zh_status"] = "none";
    let text_zh: string | null = null;
    if (b.translate) {
      translatable++;
      if (cached) {
        text_zh = cached.text_zh;
        zh_status = "done";
        translated++;
      } else {
        zh_status = "pending";
      }
    }
    return {
      id: b.id,
      type: b.type,
      sec: b.sec,
      order: b.order,
      level: b.level,
      text_en: b.text_en,
      text_zh,
      latex: b.latex,
      img_url: b.img_url,
      caption: b.caption,
      anchor: b.anchor,
      translate: b.translate,
      zh_status,
    };
  });

  return {
    paper_id: paperId,
    status: "ready",
    title: paper.title,
    arxiv_id: paper.arxiv_id,
    source_url: paper.source_url,
    toc: paper.toc,
    blocks,
    stats: {
      total: paper.blocks.length,
      translatable,
      translated,
    },
  };
}
