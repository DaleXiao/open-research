// arXiv LaTeXML HTML → block 列表解析器（客户端浏览器版）。
//
// ⚠ 移植自 research-worker/src/parse/arxiv.ts（服务器 node-html-parser 版）。
// block id 生成规则**逐字一致**——LaTeXML 元素自带稳定 id（S3.E1 / p12 / S4.F2）
// 直接复用为 block id，order/section 回退 id 规则不变。翻译缓存 / 批注锚定 / QA RAG
// 全依赖 block id，ID 错位 = 旧数据全错（硬约束#2，最高风险点）。
//
// 浏览器用原生 DOMParser（无 node-html-parser 依赖）。元素遍历用 Element/Node DOM API，
// 语义与 worker 版逐一对应：tagName / classList.contains / childNodes / id / getAttribute。

import type { BlockType, SectionNode } from "./api";

// 解析中间产物（worker types.ts 的 Block，前端解析阶段 text_zh 恒 null、无 zh_status）。
export interface ParsedBlock {
  id: string;
  type: BlockType;
  sec: string;
  order: number;
  level: number;
  text_en: string;
  text_zh: string | null;
  latex: string | null;
  img_url: string | null;
  caption: string | null;
  anchor: string;
  translate: boolean;
}

export interface ParsedPaperClient {
  source_url: string;
  source_type: "arxiv" | "pdf";
  arxiv_id: string | null;
  title: string;
  abstract: string | null;
  toc: SectionNode[];
  blocks: ParsedBlock[];
  meta: { parser: string; block_count: number; parsed_at: number };
}

export interface ArxivRefClient {
  arxiv_id: string;
  version: string | null;
  html_url: string;
  abs_url: string;
  pdf_url: string;
}

const HEADING_TAGS = new Set(["H1", "H2", "H3", "H4", "H5", "H6"]);

function tag(n: Node): string {
  return ((n as Element).tagName || "").toUpperCase();
}
function isEl(n: Node): n is Element {
  return n.nodeType === 1;
}
function cls(el: Element, c: string): boolean {
  return el.classList?.contains(c) ?? false;
}
function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/** 行内文本投影：遇到 <math> 输出 $alttext$，其余取文本。 */
function textWithMath(el: Element): string {
  let out = "";
  for (const n of Array.from(el.childNodes)) {
    if (!isEl(n)) {
      out += (n as any).textContent ?? "";
      continue;
    }
    const e = n as Element;
    if (tag(e) === "MATH") {
      const alt = e.getAttribute("alttext");
      out += alt ? `$${alt}$` : (e.textContent ?? "");
    } else {
      out += textWithMath(e);
    }
  }
  return out;
}

/** 抽取一个 math 容器内所有 alttext（方程组可能多行）。 */
function extractLatex(el: Element): string {
  const maths = el.querySelectorAll("math");
  const parts: string[] = [];
  for (const m of Array.from(maths)) {
    const alt = m.getAttribute("alttext");
    if (alt && alt.trim()) parts.push(alt.trim());
  }
  return parts.join(" \\\\ ");
}

// 相对 src 直接挂到 /html/ 根（LaTeXML 图片如 1706.03762v7/Figures/x.png）。
function resolveImg(src: string, ref: ArxivRefClient): string {
  if (!src) return src;
  if (/^https?:\/\//i.test(src)) return src;
  const clean = src.replace(/^\.?\//, "");
  if (clean.startsWith(ref.arxiv_id + "/")) {
    return `https://arxiv.org/html/${clean}`;
  }
  return `https://arxiv.org/html/${ref.arxiv_id}/${clean}`;
}

interface Ctx {
  ref: ArxivRefClient;
  blocks: ParsedBlock[];
  order: { n: number };
}

function emit(
  ctx: Ctx,
  partial: Omit<ParsedBlock, "order" | "anchor" | "text_zh">,
): void {
  const id = partial.id || `auto-${ctx.order.n}`;
  ctx.blocks.push({
    ...partial,
    id,
    order: ctx.order.n++,
    text_zh: null,
    anchor: id,
  });
}

function directHeading(el: Element): Element | null {
  for (const n of Array.from(el.childNodes)) {
    if (isEl(n) && HEADING_TAGS.has(tag(n as Element))) {
      return n as Element;
    }
  }
  return null;
}

function isSection(el: Element): boolean {
  return (
    cls(el, "ltx_section") ||
    cls(el, "ltx_subsection") ||
    cls(el, "ltx_subsubsection") ||
    cls(el, "ltx_paragraph") ||
    cls(el, "ltx_appendix")
  );
}
function isParaDiv(el: Element): boolean {
  return cls(el, "ltx_para");
}
function isMathBlock(el: Element): boolean {
  return (
    cls(el, "ltx_equation") ||
    cls(el, "ltx_equationgroup") ||
    cls(el, "ltx_eqn_table")
  );
}
function isFigure(el: Element): boolean {
  return tag(el) === "FIGURE" || cls(el, "ltx_figure") || cls(el, "ltx_table");
}

function walk(
  el: Element,
  sec: string,
  level: number,
  tocParent: SectionNode[],
  ctx: Ctx,
): void {
  for (const n of Array.from(el.childNodes)) {
    if (!isEl(n)) continue;
    const e = n as Element;

    if (cls(e, "ltx_authors") || cls(e, "ltx_title_document")) continue;

    if (isSection(e)) {
      const secId = e.id || `${sec}.s${ctx.order.n}`;
      const h = directHeading(e);
      const title = h ? collapse(textWithMath(h)) : "";
      const newLevel = level + 1;
      const node: SectionNode = { id: secId, title, level: newLevel, children: [] };
      tocParent.push(node);
      if (h && title) {
        emit(ctx, {
          id: h.id || secId,
          type: "heading",
          sec: secId,
          level: newLevel,
          text_en: title,
          latex: null,
          img_url: null,
          caption: null,
          translate: true,
        });
      }
      walk(e, secId, newLevel, node.children, ctx);
      continue;
    }

    if (isFigure(e)) {
      const img = e.querySelector("img");
      const src = img?.getAttribute("src") ?? "";
      const capEl = e.querySelector(".ltx_caption");
      const caption = capEl ? collapse(textWithMath(capEl)) : null;
      emit(ctx, {
        id: e.id || `${sec}.fig${ctx.order.n}`,
        type: "figure",
        sec,
        level,
        text_en: caption ?? "",
        latex: null,
        img_url: src ? resolveImg(src, ctx.ref) : null,
        caption,
        translate: false,
      });
      continue;
    }

    if (isMathBlock(e)) {
      const latex = extractLatex(e);
      emit(ctx, {
        id: e.id || `${sec}.eq${ctx.order.n}`,
        type: "math",
        sec,
        level,
        text_en: "",
        latex: latex || null,
        img_url: null,
        caption: null,
        translate: false,
      });
      continue;
    }

    if (isParaDiv(e)) {
      let buf: string[] = [];
      let pid: string | null = null;
      const flush = () => {
        const clean = collapse(buf.join(" "));
        if (clean) {
          emit(ctx, {
            id: pid || `${e.id || sec}.p${ctx.order.n}`,
            type: "para",
            sec,
            level,
            text_en: clean,
            latex: null,
            img_url: null,
            caption: null,
            translate: true,
          });
        }
        buf = [];
        pid = null;
      };
      const visit = (host: Element) => {
        for (const c of Array.from(host.childNodes)) {
          if (!isEl(c)) continue;
          const ce = c as Element;
          if (isMathBlock(ce)) {
            flush();
            const latex = extractLatex(ce);
            emit(ctx, {
              id: ce.id || `${sec}.eq${ctx.order.n}`,
              type: "math",
              sec,
              level,
              text_en: "",
              latex: latex || null,
              img_url: null,
              caption: null,
              translate: false,
            });
          } else if (tag(ce) === "P" && cls(ce, "ltx_p")) {
            if (!pid) pid = ce.id || null;
            buf.push(textWithMath(ce));
          } else if (isFigure(ce)) {
            flush();
            const img = ce.querySelector("img");
            const src = img?.getAttribute("src") ?? "";
            const capEl = ce.querySelector(".ltx_caption");
            const caption = capEl ? collapse(textWithMath(capEl)) : null;
            emit(ctx, {
              id: ce.id || `${sec}.fig${ctx.order.n}`,
              type: "figure",
              sec,
              level,
              text_en: caption ?? "",
              latex: null,
              img_url: src ? resolveImg(src, ctx.ref) : null,
              caption,
              translate: false,
            });
          } else {
            visit(ce);
          }
        }
      };
      visit(e);
      flush();
      continue;
    }

    walk(e, sec, level, tocParent, ctx);
  }
}

/** arXiv HTML → ParsedPaperClient。逐字对齐 worker parseArxivHtml。 */
export function parseArxivHtmlClient(html: string, ref: ArxivRefClient): ParsedPaperClient {
  const doc = new DOMParser().parseFromString(html, "text/html");

  const article =
    doc.querySelector("article") ||
    doc.querySelector(".ltx_document") ||
    doc.querySelector("body") ||
    doc.documentElement;

  const titleEl =
    doc.querySelector("h1.ltx_title_document") ||
    doc.querySelector(".ltx_title_document") ||
    doc.querySelector("title");
  const title = titleEl ? collapse(textWithMath(titleEl)) : "";

  const absEl = doc.querySelector(".ltx_abstract");
  let abstract: string | null = null;
  if (absEl) {
    const ps = absEl.querySelectorAll("p.ltx_p");
    abstract =
      collapse(
        ps.length
          ? Array.from(ps).map((p) => textWithMath(p)).join(" ")
          : textWithMath(absEl),
      ) || null;
  }

  const ctx: Ctx = { ref, blocks: [], order: { n: 0 } };
  const toc: SectionNode[] = [];

  if (abstract) {
    emit(ctx, {
      id: absEl?.id || "abstract",
      type: "para",
      sec: "abstract",
      level: 1,
      text_en: abstract,
      latex: null,
      img_url: null,
      caption: null,
      translate: true,
    });
  }

  walk(article as Element, "", 0, toc, ctx);

  return {
    source_url: ref.abs_url,
    source_type: "arxiv",
    arxiv_id: ref.arxiv_id,
    title,
    abstract,
    toc,
    blocks: ctx.blocks,
    meta: {
      parser: "latexml-v1",
      block_count: ctx.blocks.length,
      parsed_at: Date.now(),
    },
  };
}

// arXiv 源地址解析（移植自 worker arxiv-url.ts resolveArxiv，逐字一致）。
const NEW_ID = /(\d{4}\.\d{4,5})(v\d+)?/;
const OLD_ID = /([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

export function resolveArxivClient(input: string): ArxivRefClient | null {
  if (!input) return null;
  const s = input.trim();
  const m = s.match(NEW_ID) || s.match(OLD_ID);
  if (!m) return null;
  const base = m[1];
  const version = m[2] ?? null;
  const full = version ? base + version : base;
  return {
    arxiv_id: full,
    version,
    html_url: `https://arxiv.org/html/${full}`,
    abs_url: `https://arxiv.org/abs/${full}`,
    pdf_url: `https://arxiv.org/pdf/${full}`,
  };
}

/** 浏览器直接跨域 fetch arXiv HTML（arxiv /html/ 返 access-control-allow-origin:*）。 */
export async function fetchArxivHtmlClient(
  ref: ArxivRefClient,
  opts: { timeoutMs?: number } = {},
): Promise<string> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 20000);
  try {
    const res = await fetch(ref.html_url, {
      signal: ctrl.signal,
      headers: { Accept: "text/html" },
      redirect: "follow",
    });
    if (!res.ok) {
      const code = res.status === 404 ? "no_html" : "fetch_failed";
      throw new ParseClientError(
        res.status === 404
          ? `arXiv 无 HTML 版（仅 PDF，将回退 PDF 底座）：${ref.html_url}`
          : `抓取失败 HTTP ${res.status}：${ref.html_url}`,
        code,
      );
    }
    return await res.text();
  } catch (e) {
    if (e instanceof ParseClientError) throw e;
    if ((e as any)?.name === "AbortError") {
      throw new ParseClientError(`抓取超时：${ref.html_url}`, "timeout");
    }
    throw new ParseClientError(`抓取异常：${String(e)}`, "fetch_failed");
  } finally {
    clearTimeout(t);
  }
}

/** 前端解析错误（带 code，对齐 worker ParseError 语义）。 */
export class ParseClientError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ParseClientError";
    this.code = code;
  }
}
