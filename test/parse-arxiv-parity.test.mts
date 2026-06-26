//  关键回归：前端 arXiv 解析器 block ID 与服务器解析器**逐字一致**。
//
// 最高风险点（硬约束#2）：翻译缓存 / 批注锚定 / QA RAG 全依赖 block ID。解析挪客户端后，
// 前端 parseArxivHtmlClient 产出的 block id / type / sec / order / level / translate 必须与
// 服务器 parseArxivHtml（golden 快照，由 research-worker/scripts/gen-golden.mts 生成）完全相同，
// 否则旧已导入论文的翻译/批注/QA 数据全部错位。
//
// 跑法：node --import tsx test/parse-arxiv-parity.test.mjs
// Node 无原生 DOMParser → 注入 linkedom 的 DOMParser 作全局（浏览器运行时用原生，行为对齐）。

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DOMParser } from "linkedom";

// 注入全局 DOMParser（parse-arxiv.ts 用 `new DOMParser()`）。
(globalThis as Record<string, unknown>).DOMParser = DOMParser;

const here = dirname(fileURLToPath(import.meta.url));
const { parseArxivHtmlClient, resolveArxivClient } = await import("../src/lib/parse-arxiv.ts");

const golden = JSON.parse(readFileSync(join(here, "fixtures/golden-blockids.json"), "utf8"));

let fail = 0;
function check(name: string, cond: boolean, info?: unknown) {
  if (cond) console.log(`  ✓ ${name}`);
  else { fail++; console.log(`  ✗ ${name}`, info ?? ""); }
}

const cases: Array<[string, string]> = [
  ["fixtures/fixture-1706.03762v7.html", "1706.03762v7"],
  ["fixtures/fixture-2310.06825v1.html", "2310.06825v1"],
];

for (const [file, id] of cases) {
  console.log(`\n=== parity: ${id} ===`);
  const html = readFileSync(join(here, file), "utf8");
  const ref = resolveArxivClient(id)!;
  const paper = parseArxivHtmlClient(html, ref);
  const g = golden[id];

  check(`title 一致`, paper.title === g.title, `front="${paper.title}" golden="${g.title}"`);
  check(`block_count 一致 (${g.block_count})`, paper.blocks.length === g.block_count, `front=${paper.blocks.length} golden=${g.block_count}`);

  // 逐 block 严格对齐 id/type/sec/order/level/translate。
  const n = Math.max(paper.blocks.length, g.blocks.length);
  let mismatch = 0;
  const samples: string[] = [];
  for (let i = 0; i < n; i++) {
    const f = paper.blocks[i];
    const gb = g.blocks[i];
    if (!f || !gb) { mismatch++; if (samples.length < 5) samples.push(`#${i}: ${f ? "front-only" : "golden-only"}`); continue; }
    const same =
      f.id === gb.id && f.type === gb.type && f.sec === gb.sec &&
      f.order === gb.order && f.level === gb.level && f.translate === gb.translate;
    if (!same) {
      mismatch++;
      if (samples.length < 5) samples.push(`#${i}: front{id=${f.id},type=${f.type},sec=${f.sec},lvl=${f.level},tr=${f.translate}} vs golden{id=${gb.id},type=${gb.type},sec=${gb.sec},lvl=${gb.level},tr=${gb.translate}}`);
    }
  }
  check(`所有 block id/type/sec/order/level/translate 逐字一致`, mismatch === 0, mismatch ? `${mismatch} 处不符，前 5:\n    ${samples.join("\n    ")}` : "");

  // toc 顶层 id 一致（脑图/目录依赖）。
  const tocIds = paper.toc.map((nn: any) => nn.id);
  check(`toc 顶层 id 一致`, JSON.stringify(tocIds) === JSON.stringify(g.toc_ids), `front=${JSON.stringify(tocIds)} golden=${JSON.stringify(g.toc_ids)}`);
}

console.log(fail === 0 ? "\nALL PARITY TESTS PASS ✅ — 前后端 block ID 逐字一致" : `\n${fail} FAILED ❌ — block ID 错位风险！`);
process.exit(fail === 0 ? 0 : 1);
