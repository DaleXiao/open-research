// 客户端解析编排入口。
// 用户输入 → 浏览器解析（arXiv HTML / PDF，都在用户 CPU 上跑，无 isolate CPU 墙）→
// 得到 {paper_id, source_url, source_type, arxiv_id, title, blocks}，交给 worker 落库。
//
// 路由（对齐 worker parse/index.ts parseSource 三层）：
//  ① arXiv id/url → fetch /html/（DOMParser 解）→ 404/no_html/empty 回退 PDF 底座（身份保 arxiv id）
//  ② .pdf URL（任意域名）→ PDF 底座
//  ③ 任意 http(s) URL → fetch 探 %PDF magic → 是则走底座
//  ④ 都不匹配 → unsupported_source

import {
  parseArxivHtmlClient,
  resolveArxivClient,
  fetchArxivHtmlClient,
  ParseClientError,
  type ParsedPaperClient,
  type ArxivRefClient,
} from "./parse-arxiv";
import {
  parsePdfUrlClient,
  looksLikePdfUrl,
  pdfPaperIdClient,
  ParseError as PdfParseError,
  type ParsedPaper as ParsedPaperPdf,
} from "./parse-pdf";

/** arXiv paper_id = 带版本 arxiv_id（与 worker paperIdFor 一致）。 */
export async function paperIdForClient(input: string): Promise<string> {
  const ref = resolveArxivClient(input);
  if (ref?.arxiv_id) return ref.arxiv_id;
  if (looksLikePdfUrl(input) || /^https?:\/\//i.test(input.trim())) {
    return pdfPaperIdClient(input);
  }
  return input.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80);
}

/**
 * 客户端解析任意来源 → ParsedPaperClient。逐层路由对齐 worker parseSource。
 * 抛 ParseClientError（带 code）供前端按场景提示。
 */
export async function parseSourceClient(input: string): Promise<ParsedPaperClient> {
  // ① arXiv：HTML-first，404/no_html/empty 回退 PDF（身份保 arxiv id）。
  const ref: ArxivRefClient | null = resolveArxivClient(input);
  if (ref) {
    try {
      const html = await fetchArxivHtmlClient(ref);
      const paper = parseArxivHtmlClient(html, ref);
      if (paper.blocks.length === 0) {
        throw new ParseClientError(
          `解析得到 0 个 block，可能 HTML 结构非标准 LaTeXML：${ref.html_url}`,
          "empty_parse",
        );
      }
      return paper;
    } catch (e) {
      // arXiv HTML fetch 失败都回退 PDF 底座（身份保 arxiv id）。
      // 根因：arxiv /html/ 的 404 响应**不带 ACAO 头** → 浏览器在代码拿到 404 前就
      // 被 CORS 拦截招 TypeError → fetchArxivHtmlClient catch 归为 fetch_failed（拿不到状态码
      // 所以不是 no_html）。故 fetch_failed 也必须 fallbackable——HTML fetch 失败（CORS 拦/网络/
      // 非404 状态）都意味 HTML 不可用，应回退 PDF。
      // 保留 timeout 不 fallback：超时是临时性，重试更合理，避免误把「慢」当「无 HTML」。
      const fallbackable =
        e instanceof ParseClientError &&
        (e.code === "no_html" || e.code === "empty_parse" || e.code === "fetch_failed");
      if (!fallbackable) throw e;
      // 回退 PDF 底座，身份保 arxiv（paper_id 一致，缓存/批注/笔记/脑图不分裂）。
      try {
        return (await parsePdfUrlClient(ref.pdf_url, {
          arxivContext: { arxiv_id: ref.arxiv_id, abs_url: ref.abs_url },
        })) as unknown as ParsedPaperClient;
      } catch (pe) {
        const htmlMsg = e instanceof ParseClientError ? e.message : String(e);
        const pdfMsg =
          pe instanceof ParseClientError || pe instanceof PdfParseError ? pe.message : String(pe);
        throw new ParseClientError(
          `arXiv ${ref.arxiv_id}：HTML 不可用且 PDF 回退也失败。HTML：${htmlMsg}；PDF：${pdfMsg}`,
          "arxiv_both_failed",
        );
      }
    }
  }

  // ② .pdf URL（任意域名）→ PDF 底座。
  if (looksLikePdfUrl(input)) {
    return (await parsePdfUrlClient(input)) as unknown as ParsedPaperClient;
  }

  // ③ 任意 http(s) URL → 探 content-type/magic（fetchPdfBytesClient 内部校验）。
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) {
    try {
      return (await parsePdfUrlClient(trimmed)) as unknown as ParsedPaperClient;
    } catch (e) {
      if (
        (e instanceof ParseClientError || e instanceof PdfParseError) &&
        e.code === "not_pdf"
      ) {
        throw new ParseClientError(
          `不是 arXiv，且 URL 内容非 PDF（content-type/磁数不符）：${trimmed}`,
          "unsupported_source",
        );
      }
      throw e;
    }
  }

  // ④ 都不匹配。
  throw new ParseClientError(
    `无法识别 arXiv 链接/ID 或 PDF URL：${input}`,
    "unsupported_source",
  );
}

export { ParseClientError } from "./parse-arxiv";
export type { ParsedPaperClient } from "./parse-arxiv";
