import { readFileSync, writeFileSync } from "node:fs";
import { resolveArxiv } from "../src/parse/arxiv-url.js";
import { parseArxivHtml } from "../src/parse/arxiv.js";

const fixtures: Array<[string, string]> = [
  ["test/fixture-1706.03762v7.html", "1706.03762v7"],
  ["test/fixture-2310.06825v1.html", "2310.06825v1"],
];
const golden: Record<string, any> = {};
for (const [file, id] of fixtures) {
  const ref = resolveArxiv(id)!;
  const html = readFileSync(file, "utf8");
  const paper = parseArxivHtml(html, ref);
  golden[id] = {
    title: paper.title,
    block_count: paper.blocks.length,
    blocks: paper.blocks.map((b) => ({ id: b.id, type: b.type, sec: b.sec, order: b.order, level: b.level, translate: b.translate })),
    toc_ids: paper.toc.map((n) => n.id),
  };
}
writeFileSync("test/golden-blockids.json", JSON.stringify(golden, null, 2));
console.log("golden:", Object.keys(golden).map(k => `${k}=${golden[k].block_count}`).join(", "));
