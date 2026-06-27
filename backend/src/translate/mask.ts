// 行内公式保护：把 para.text_en 里的 $...$ 占位换成稳定哨兵，翻译后还原。
// "公式不坏" 是 M2 硬验收项 —— 不依赖 qwen-mt 自觉保留 LaTeX，而是 mask→翻→unmask，
// 并在还原阶段校验哨兵完整性，缺失则降级为「分段翻译（只翻散文，公式原样拼回）」。

/** 哨兵用罕见全角括号 + 序号，MT 一般原样透传；还原时严格匹配。 */
const SENTINEL = (i: number) => `⟦F${i}⟧`;
const SENTINEL_RE = /⟦F(\d+)⟧/g;

// 行内公式 token：$...$（非贪婪，禁跨 $$，M1 投影里行内公式恒为单 $）
const INLINE_MATH_RE = /\$[^$]+\$/g;

export interface Masked {
  /** 替换公式为哨兵后的文本，送翻用 */
  masked: string;
  /** 序号 → 原始 $latex$ 片段 */
  formulas: string[];
  /** 是否含行内公式 */
  hasMath: boolean;
}

export function maskInlineMath(text: string): Masked {
  const formulas: string[] = [];
  const masked = text.replace(INLINE_MATH_RE, (m) => {
    const idx = formulas.length;
    formulas.push(m);
    return SENTINEL(idx);
  });
  return { masked, formulas, hasMath: formulas.length > 0 };
}

export interface Unmasked {
  text: string;
  /** 全部哨兵都成功还原 */
  ok: boolean;
  /** 译文中实际出现的哨兵序号集合 */
  found: number[];
}

/** 把译文里的哨兵还原成原公式。校验是否所有公式都被还原。 */
export function unmaskInlineMath(translated: string, formulas: string[]): Unmasked {
  const found = new Set<number>();
  const text = translated.replace(SENTINEL_RE, (_m, n: string) => {
    const i = Number(n);
    if (i >= 0 && i < formulas.length) {
      found.add(i);
      return formulas[i];
    }
    return _m; // 越界哨兵：保留原样（异常，由 ok 判定捕获）
  });
  const ok = found.size === formulas.length;
  return { text, ok, found: [...found].sort((a, b) => a - b) };
}

/**
 * 降级：当哨兵还原不完整（MT 改/丢了哨兵）时，按行内公式把原文切成
 * [散文, 公式, 散文, 公式, ...]，只对散文段调用 translateFn，公式原样拼回。
 * 保证公式 100% 不坏，代价是 MT 失去跨公式上下文。
 */
export async function translateBySplit(
  text: string,
  translateFn: (prose: string) => Promise<string>,
): Promise<string> {
  const parts: string[] = [];
  let last = 0;
  const re = new RegExp(INLINE_MATH_RE.source, "g");
  let m: RegExpExecArray | null;
  const segs: { prose: boolean; text: string }[] = [];
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) segs.push({ prose: true, text: text.slice(last, m.index) });
    segs.push({ prose: false, text: m[0] });
    last = m.index + m[0].length;
  }
  if (last < text.length) segs.push({ prose: true, text: text.slice(last) });

  for (const s of segs) {
    if (!s.prose) {
      parts.push(s.text); // 公式原样
      continue;
    }
    const trimmed = s.text.trim();
    if (!trimmed) {
      parts.push(s.text);
      continue;
    }
    // 保留前后空白，翻中间实体
    const lead = s.text.match(/^\s*/)?.[0] ?? "";
    const tail = s.text.match(/\s*$/)?.[0] ?? "";
    const zh = await translateFn(trimmed);
    parts.push(lead + zh + tail);
  }
  return parts.join("");
}
