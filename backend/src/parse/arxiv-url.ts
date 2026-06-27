// arXiv 源地址解析：把用户给的各种 arXiv 链接/裸 id 归一化到
// { arxiv_id, html_url, abs_url }。HTML-first（LaTeXML 渲染版）。

export interface ArxivRef {
  arxiv_id: string;        // 1706.03762 或 1706.03762v7 或 cs/0309040
  version: string | null;  // v7 / null
  html_url: string;        // https://arxiv.org/html/<id>
  abs_url: string;         // https://arxiv.org/abs/<id>
  pdf_url: string;         // https://arxiv.org/pdf/<id>（F3-fix：HTML 404 回退 PDF 底座）
}

// 支持：
//   https://arxiv.org/abs/1706.03762
//   https://arxiv.org/abs/1706.03762v7
//   https://arxiv.org/html/1706.03762v7
//   https://arxiv.org/pdf/1706.03762
//   arxiv.org/abs/1706.03762
//   1706.03762 / 1706.03762v7
//   cs/0309040（旧式 id）
const NEW_ID = /(\d{4}\.\d{4,5})(v\d+)?/;
const OLD_ID = /([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?/i;

export function resolveArxiv(input: string): ArxivRef | null {
  if (!input) return null;
  const s = input.trim();

  let m = s.match(NEW_ID) || s.match(OLD_ID);
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

export function isArxivUrl(input: string): boolean {
  return resolveArxiv(input) !== null;
}
