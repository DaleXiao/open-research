// M1 — 统一 block 化中间格式
// 任何源（arXiv HTML/LaTeX 优先 + 任意在线 PDF）→ 带稳定 id 的 block 列表。
// MD 是人类可读投影，非存储本体。四功能全挂 block id。

export type BlockType = "para" | "math" | "figure" | "heading";

export interface Block {
  /** 稳定 id。arXiv 源直接复用 LaTeXML 的 id（S3.E1 / p12 / S4.F2）。 */
  id: string;
  type: BlockType;
  /** 所属章节 id（最近祖先 section），顶层为 "" */
  sec: string;
  /** 全文线性顺序，从 0 起 */
  order: number;
  /** 章节深度：section=1, subsection=2, ...；非 heading 为所在 section 深度 */
  level: number;
  /** 英文原文（para/heading 的纯文本投影，行内公式以 $latex$ 占位保留） */
  text_en: string;
  /** 懒翻：解析阶段恒为 null，M2 翻译时回填 */
  text_zh: string | null;
  /** math block 的 LaTeX（来自 alttext），其他类型为 null */
  latex: string | null;
  /** figure/table 的图片地址（绝对化），其他类型为 null */
  img_url: string | null;
  /** figure/table 的题注纯文本，其他类型为 null */
  caption: string | null;
  /** 锚点：用于批注/滚动定位，默认等于 id */
  anchor: string;
  /** 是否送翻：公式/图表恒 false，正文/标题 true */
  translate: boolean;
}

export interface SectionNode {
  id: string;
  title: string;
  level: number;
  children: SectionNode[];
}

export interface ParsedPaper {
  source_url: string;
  source_type: "arxiv" | "pdf";
  arxiv_id: string | null;
  title: string;
  abstract: string | null;
  /** 章节树（用于脑图遍历 / 目录） */
  toc: SectionNode[];
  blocks: Block[];
  /** 解析元信息 */
  meta: {
    parser: string;
    block_count: number;
    parsed_at: number;
  };
}
