// — PDF 解析挪客户端（浏览器）。
// 源：research-worker/src/parse/pdf.ts（CF Worker + unpdf serverless build）。
// 本文件把该启发式分块逻辑逐行移植到浏览器，改用 pdfjs-dist（浏览器主场库）。
//
// 关键差异 vs worker：
//  - 解析库：unpdf(getDocumentProxy) → pdfjs-dist(getDocument)。两者底层都是 pdf.js，
//    page.getTextContent().items 形状一致（{ str, transform }），故聚行/字号启发式不变。
//  - 运行环境：浏览器原生有 DOMMatrix，无需 unpdf 的 serverless polyfill build。
//  - 懒加载（硬约束#4）：pdfjs-dist(~主 bundle 1MB+ + worker)全部 `await import(...)`，
//    不进首屏包；仅当用户真的解析 PDF 时按需拉取。pdf.worker 同样动态 `?url` 注入。
//
// 硬约束#2（block ID 逐字一致）：para 块 id = `pdf.p${paraStartLine}`、heading 块
//   id = `pdf.sec${order}`。order 递增、paraStartLine 行号逻辑、字号启发式、noise
//   过滤、maxPages 上限全部与 worker 源逐字对齐，否则翻译缓存/批注/QA 的 block ID 错位。

// ── 类型（内联对齐 worker src/parse/types.ts；前端 api.ts 只有 BilingualBlock，
//     缺解析阶段裸 Block/ParsedPaper，故此处内联，结构与 worker 完全一致）──────────

export type BlockType = "para" | "math" | "figure" | "heading";

export interface Block {
  /** 稳定 id。PDF 源：para=`pdf.p<行号>`、heading=`pdf.sec<order>`。 */
  id: string;
  type: BlockType;
  /** 所属章节 id（最近祖先 section），顶层为 "" */
  sec: string;
  /** 全文线性顺序，从 0 起 */
  order: number;
  /** 章节深度：section=1, subsection=2, ...；非 heading 为所在 section 深度 */
  level: number;
  /** 英文原文（para/heading 纯文本投影） */
  text_en: string;
  /** 懒翻：解析阶段恒为 null */
  text_zh: string | null;
  /** math block 的 LaTeX，其他类型为 null */
  latex: string | null;
  /** figure/table 图片地址，其他类型为 null */
  img_url: string | null;
  /** figure/table 题注，其他类型为 null */
  caption: string | null;
  /** 锚点：默认等于 id */
  anchor: string;
  /** 是否送翻：公式/图表 false，正文/标题 true */
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
  toc: SectionNode[];
  blocks: Block[];
  meta: {
    parser: string;
    block_count: number;
    parsed_at: number;
  };
}

/** 解析错误（对齐 worker ParseError，前端复用同 code 集合）。 */
export class ParseError extends Error {
  code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "ParseError";
    this.code = code;
  }
}

export interface PdfParseOpts {
  timeoutMs?: number;
  /** 解析页数上限（超大 PDF 兜底）。默认 60，与 worker 一致。 */
  maxPages?: number;
  /**
   * arXiv HTML 404 回退 PDF 时的源身份覆盖。传入则 source_type 仍标 'arxiv'、
   * arxiv_id 保留 → 同一篇论文 HTML/回退 PDF 同一 paper_id。
   */
  arxivContext?: { arxiv_id: string; abs_url: string };
}

// ── 启发式常量 / 工具（逐字对齐 worker）──────────────────────────────────────

// 编号标题：`1. Introduction` / `3.1 Model` / `References` / `Abstract` / `Appendix A`
const HEADING_RE =
  /^(\d+(?:\.\d+)*\.?\s+[A-Z][\w-]|References\b|Abstract\b|Acknowledge?ments?\b|Appendix\b|Conclusions?\b)/;

function fontSize(transform: number[]): number {
  return Math.hypot(transform[2], transform[3]);
}

/**
 * 抓取 PDF bytes（浏览器版）。校验 content-type / magic number，避免把 HTML 错喂 pdf.js。
 * 浏览器直接跨域 fetch：arxiv pdf 返 `access-control-allow-origin: *`，可直拉。
 * 对齐 worker fetchPdfBytes。
 */
export async function fetchPdfBytesClient(
  url: string,
  opts: PdfParseOpts = {},
): Promise<Uint8Array> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30000);
  try {
    // hotfix：不设任何自定义/多值 header。
    // 原 'Accept: application/pdf,*/*' 含逗号/* → 非 CORS-safelisted → 触发 preflight(OPTIONS)；
    // arxiv /pdf/ 的 OPTIONS 响应不带 access-control-* 头 → preflight 失败 → Failed to fetch。
    // 去掉 Accept 退回 CORS 简单请求（纯 GET、无自定义头）→ 不触发 preflight。
    // content-type/%PDF magic 校验读响应体自己探，不依赖 Accept。
    // 浏览器禁止设 User-Agent（forbidden header），同样省略。
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: "follow",
    });
    if (!res.ok) {
      throw new ParseError(
        `抓取 PDF 失败 HTTP ${res.status}：${url}`,
        res.status === 404 ? "no_html" : "fetch_failed",
      );
    }
    const buf = new Uint8Array(await res.arrayBuffer());
    // 双识别①：magic number %PDF 为准（不依赖 .pdf 后缀）。
    const isPdfMagic =
      buf.length >= 5 &&
      buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46; // %PDF
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    const ctSaysPdf = ct.includes("application/pdf") || ct.includes("application/x-pdf");
    if (!isPdfMagic) {
      throw new ParseError(
        ctSaysPdf
          ? `content-type 声称 PDF 但内容缺 %PDF 头（可能是错路由/限流页）：${url}`
          : `URL 不是有效 PDF（缺 %PDF 头）：${url}`,
        "not_pdf",
      );
    }
    return buf;
  } catch (e) {
    if (e instanceof ParseError) throw e;
    if ((e as { name?: string })?.name === "AbortError") {
      throw new ParseError(`抓取 PDF 超时：${url}`, "timeout");
    }
    throw new ParseError(`抓取 PDF 异常：${String(e)}`, "fetch_failed");
  } finally {
    clearTimeout(t);
  }
}

interface Line {
  text: string;
  maxFs: number;
  page: number;
}

/** 把一页 textContent 聚成行（按 y 坐标分组，y 降序=阅读序）。逐字对齐 worker。 */
function pageToLines(
  items: Array<{ str: string; transform: number[] }>,
  page: number,
): Line[] {
  const byY = new Map<number, Array<{ str: string; transform: number[] }>>();
  for (const it of items) {
    if (!it.str) continue;
    const y = Math.round(it.transform[5]);
    let arr = byY.get(y);
    if (!arr) {
      arr = [];
      byY.set(y, arr);
    }
    arr.push(it);
  }
  const ys = [...byY.keys()].sort((a, b) => b - a);
  const lines: Line[] = [];
  for (const y of ys) {
    const arr = byY.get(y)!;
    const text = arr.map((i) => i.str).join("").replace(/\s+/g, " ").trim();
    if (!text) continue;
    const maxFs = Math.max(...arr.map((i) => fontSize(i.transform)));
    lines.push({ text, maxFs, page });
  }
  return lines;
}

/** 推断正文字号（众数）。逐字对齐 worker。 */
function inferBodyFontSize(lines: Line[]): number {
  const hist = new Map<number, number>();
  for (const l of lines) {
    const k = Math.round(l.maxFs * 2) / 2; // 0.5 粒度
    hist.set(k, (hist.get(k) ?? 0) + 1);
  }
  let best = 10;
  let bestN = 0;
  for (const [k, n] of hist) {
    if (n > bestN) {
      bestN = n;
      best = k;
    }
  }
  return best;
}

function isHeading(line: Line, bodyFs: number): boolean {
  if (line.text.length > 80) return false;
  if (HEADING_RE.test(line.text)) return true;
  // 字号明显大于正文（≥1.15x）且短 → 视作标题
  return line.maxFs >= bodyFs * 1.15 && line.text.length >= 2;
}

/**
 * 懒加载 pdfjs-dist 并配置 worker。硬约束#4：全部动态 import，不进首屏包。
 * worker 用 Vite `?url` 资源导入指向 pdfjs-dist 自带 build/pdf.worker.mjs，
 * 经 Astro/Vite 构建会被产出为带 hash 的静态资源并按需加载。
 */
async function loadPdfjs() {
  const pdfjs = await import("pdfjs-dist");
  // 仅首次设置 workerSrc（GlobalWorkerOptions 全局单例，重复设置无害但跳过更省）。
  if (!pdfjs.GlobalWorkerOptions.workerSrc) {
    // Vite/Astro：`?url` 让构建器把 worker 当静态资源产出并返回最终 URL。
    const workerUrl = (await import("pdfjs-dist/build/pdf.worker.mjs?url")).default;
    pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  }
  return pdfjs;
}

/**
 * 解析 PDF bytes → ParsedPaper（浏览器版）。纯文本启发式分块。
 * 签名对齐 worker parsePdfBytes，行为/分块/ID 一致。
 * @param bytes     PDF 原始字节
 * @param sourceUrl 原始 URL（落 source_url）
 */
export async function parsePdfClient(
  bytes: Uint8Array,
  sourceUrl: string,
  opts: PdfParseOpts = {},
): Promise<ParsedPaper> {
  const pdfjs = await loadPdfjs();
  let pdf: Awaited<ReturnType<typeof pdfjs.getDocument>["promise"]>;
  try {
    // pdfjs getDocument 会 transfer 底层 ArrayBuffer；复制一份避免污染调用方 bytes。
    const data = bytes.slice();
    pdf = await pdfjs.getDocument({ data }).promise;
  } catch (e) {
    throw new ParseError(`PDF 解析失败（可能损坏/加密）：${String(e)}`, "pdf_decode_failed");
  }
  const numPages = Math.min(pdf.numPages, opts.maxPages ?? 60);
  if (pdf.numPages === 0) {
    throw new ParseError("PDF 无页面", "empty_parse");
  }

  // 收集所有页的行
  const allLines: Line[] = [];
  for (let p = 1; p <= numPages; p++) {
    const page = await pdf.getPage(p);
    const tc = await page.getTextContent();
    const items = tc.items as Array<{ str: string; transform: number[] }>;
    allLines.push(...pageToLines(items, p));
  }

  if (allLines.length === 0) {
    throw new ParseError(
      "PDF 无文本层（可能是扫描件/纯图片），本版不支持 OCR",
      "no_text_layer",
    );
  }

  const bodyFs = inferBodyFontSize(allLines);

  // 标题：取第 1 页字号最大的前几行拼（多为论文标题跨行）。先过噪声过滤。
  const isNoise = (s: string): boolean => {
    if (/arxiv\s*:/i.test(s)) return true; // arXiv:2507.19457v2 [cs.CL]
    if (/\[(cs|math|stat|eess|physics|q-bio|q-fin|econ|astro-ph|cond-mat|hep|gr-qc|nlin|nucl|quant-ph)[.\]]/i.test(s)) return true;
    if (/\b(19|20)\d{2}\b/.test(s) && /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(s)) return true;
    // 数字/空白占比 >50% → 图表轴/表格
    const digits = (s.match(/\d/g) || []).length;
    if (s.length > 0 && digits / s.length > 0.5) return true;
    return false;
  };
  const firstPageLines = allLines.filter((l) => l.page === 1 && !isNoise(l.text));
  const maxFsOnP1 = firstPageLines.length
    ? Math.max(...firstPageLines.map((l) => l.maxFs))
    : 0;
  const titleCands = firstPageLines.filter(
    (l) =>
      l.maxFs >= maxFsOnP1 - 0.5 &&
      l.text.length > 3 &&
      l.text.length < 160 &&
      /[A-Za-z\u4e00-\u9fa5]/.test(l.text) &&
      !/^\d+$/.test(l.text),
  );
  let title = titleCands.slice(0, 3).map((l) => l.text).join(" ").replace(/\s+/g, " ").trim();

  // 分块：遍历行，heading 起新 section，正文累积成 para。
  const blocks: Block[] = [];
  const toc: SectionNode[] = [];
  let order = 0;
  let curSec = "";
  let curLevel = 1;
  let paraBuf: string[] = [];
  let paraStartLine = 0;
  let lineIdx = 0;

  const flushPara = () => {
    if (!paraBuf.length) return;
    const text = paraBuf.join(" ").replace(/\s+/g, " ").trim();
    paraBuf = [];
    if (text.length < 2) return;
    blocks.push({
      id: `pdf.p${paraStartLine}`,
      type: "para",
      sec: curSec,
      order: order++,
      level: curLevel,
      text_en: text,
      text_zh: null,
      latex: null,
      img_url: null,
      caption: null,
      anchor: `pdf.p${paraStartLine}`,
      translate: true,
    });
  };

  for (const line of allLines) {
    lineIdx++;
    // 跳过明显页眉页脚（纯数字页码 / 极短）
    if (/^\d{1,4}$/.test(line.text)) continue;
    if (isHeading(line, bodyFs)) {
      flushPara();
      // section 深度：编号点数（1=1级，1.1=2级）
      const numMatch = line.text.match(/^(\d+(?:\.\d+)*)/);
      const level = numMatch ? numMatch[1].split(".").length : 1;
      const secId = `pdf.sec${order}`;
      curSec = secId;
      curLevel = level;
      blocks.push({
        id: secId,
        type: "heading",
        sec: secId,
        order: order++,
        level,
        text_en: line.text,
        text_zh: null,
        latex: null,
        img_url: null,
        caption: null,
        anchor: secId,
        translate: true,
      });
      // toc：1 级进根，深层挂最近祖先（简化：全挂根，前端目录够用）
      const node: SectionNode = { id: secId, title: line.text, level, children: [] };
      if (level === 1 || toc.length === 0) {
        toc.push(node);
      } else {
        toc[toc.length - 1].children.push(node);
      }
    } else {
      if (!paraBuf.length) paraStartLine = lineIdx;
      paraBuf.push(line.text);
      // 长 buffer 强制 flush 防止单段过长
      if (paraBuf.join(" ").length > 1200) flushPara();
    }
  }
  flushPara();

  if (blocks.length === 0) {
    throw new ParseError("PDF 解析得到 0 个 block", "empty_parse");
  }

  // arXiv 回退 PDF 时保留 arxiv 身份（paper_id 一致性），否则纯 PDF。
  const arxivCtx = opts.arxivContext;
  // 兜底标题：页首候选不出 → 取首个 heading block 文本；再不行 Untitled PDF。
  let finalTitle = title;
  if (finalTitle.length < 4) {
    const firstHeading = blocks.find((b) => b.type === "heading" && b.text_en.length > 4);
    finalTitle = firstHeading ? firstHeading.text_en.trim() : "";
  }
  if (finalTitle.length < 4) finalTitle = "Untitled PDF";
  return {
    source_url: arxivCtx ? arxivCtx.abs_url : sourceUrl,
    source_type: arxivCtx ? "arxiv" : "pdf",
    arxiv_id: arxivCtx ? arxivCtx.arxiv_id : null,
    title: finalTitle,
    abstract: null,
    toc,
    blocks,
    meta: {
      // 客户端解析器标识，与 worker(unpdf-v1) 区分但 block 结构/ID 完全一致。
      parser: arxivCtx ? "pdfjs-client-v1-arxiv-fallback" : "pdfjs-client-v1",
      block_count: blocks.length,
      parsed_at: Date.now(),
    },
  };
}

/** 便捷：URL → 抓取 → 解析（浏览器版）。对齐 worker parsePdfUrl。 */
export async function parsePdfUrlClient(
  url: string,
  opts: PdfParseOpts = {},
): Promise<ParsedPaper> {
  const bytes = await fetchPdfBytesClient(url, opts);
  return parsePdfClient(bytes, url, opts);
}

/** PDF URL 识别：以 .pdf 结尾（忽略 query）。对齐 worker looksLikePdfUrl。 */
export function looksLikePdfUrl(input: string): boolean {
  const s = input.trim();
  if (!/^https?:\/\//i.test(s)) return false;
  try {
    const u = new URL(s);
    return /\.pdf$/i.test(u.pathname);
  } catch {
    return false;
  }
}

/**
 * URL 规范化（hash 前用），防同一篇 PDF 多 URL 变体哈出不同 id。
 * 移植自 worker parse/pdf.ts normalizePdfUrl，逐字一致（paper_id 必须与 worker 一致）。
 */
export function normalizePdfUrl(input: string): string {
  const s = input.trim();
  try {
    const u = new URL(s);
    u.protocol = "https:";
    u.hostname = u.hostname.toLowerCase();
    if (
      (u.protocol === "https:" && u.port === "443") ||
      (u.protocol === "http:" && u.port === "80")
    ) {
      u.port = "";
    }
    u.hash = "";
    const TRACKING = /^(utm_|ref$|source$|fbclid$|gclid$|mc_)/i;
    const keep: Array<[string, string]> = [];
    for (const [k, v] of u.searchParams) {
      if (!TRACKING.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    let out = u.toString();
    out = out.replace(/\/(\?|$)/, "$1").replace(/\/$/, "");
    return out;
  } catch {
    return s;
  }
}

/**
 * PDF 源 paper_id：normalize URL 后 SHA-256 hash 前 8 字节，前缀 pdf-。
 * 移植自 worker parse/index.ts pdfPaperId，逐字一致（浏览器 crypto.subtle 同 API）。
 */
export async function pdfPaperIdClient(url: string): Promise<string> {
  const data = new TextEncoder().encode(normalizePdfUrl(url));
  const digest = await crypto.subtle.digest("SHA-256", data);
  const hex = [...new Uint8Array(digest)]
    .slice(0, 8)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `pdf-${hex}`;
}
