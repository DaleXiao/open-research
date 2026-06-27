// M2 / — 真翻 e2e（token 落地后跑）。由 e2e-translate.sh 调用。
// 抓真实 arXiv → parseSource → 懒翻前 N 个可翻 para → 断言：有中文 + 行内公式 100% 保留。
//
// env: RESEARCH_TOKEN（必需）、GATEWAY_URL（默认 prod）。
import { parseSource } from "../src/parse/index.js";
import { translateBlocks } from "../src/translate/engine.js";
import type { GatewayConfig } from "../src/llm/gateway.js";

const arxivId = process.argv[2] ?? "1706.03762v7";
const token = process.env.RESEARCH_TOKEN;
const baseUrl = process.env.GATEWAY_URL ?? "https://api-llm.example.com";

if (!token) {
  console.error("RESEARCH_TOKEN 未设置（应由 e2e-translate.sh 注入）");
  process.exit(2);
}

const gateway: GatewayConfig = { baseUrl, token };

let fail = 0;
const check = (name: string, cond: boolean, info?: unknown) => {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
};

// 行内公式 token：$...$（与 mask.ts 同源约定）
const INLINE_MATH = /\$[^$]+\$/g;
const mathSet = (s: string): string[] => (s.match(INLINE_MATH) ?? []).sort();

async function main() {
  console.log(`▸ parse ${arxivId} ...`);
  const paper = await parseSource(arxivId);
  check("解析出 title", !!paper.title);
  check("blocks 非空", paper.blocks.length > 20);

  // 取前 8 个可翻 para（含行内公式的优先，验证“公式不坏”）。
  const paras = paper.blocks.filter((b) => b.translate && b.text_en.trim());
  const withMath = paras.filter((b) => INLINE_MATH.test(b.text_en));
  const sample = [...withMath.slice(0, 4), ...paras.slice(0, 4)].slice(0, 8);
  console.log(`▸ 懒翻 ${sample.length} 个 para（其中 ${withMath.length ? Math.min(4, withMath.length) : 0} 含行内公式）...`);

  const translations = await translateBlocks(sample, { gateway });

  let translatedCount = 0;
  for (const b of sample) {
    const t = translations.find((x) => x.block_id === b.id) ?? null;
    if (t?.text_zh) {
      translatedCount++;
      // 公式不坏：原文里的 $...$ 集合必须全部出现在译文里。
      const before = mathSet(b.text_en);
      if (before.length) {
        const after = mathSet(t.text_zh);
        const allKept = before.every((f) => after.includes(f));
        check(`公式不坏 [${b.id}] (${before.length} 个)`, allKept, { before, after });
      }
      // 译文应含中日韩字符（确实翻成了中文）。
      check(`有中文译文 [${b.id}]`, /[\u4e00-\u9fff]/.test(t.text_zh));
    }
  }
  check("至少翻成功 1 段", translatedCount >= 1, `translated=${translatedCount}`);

  console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${fail} failure(s)`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("e2e 异常：", e);
  process.exit(1);
});
