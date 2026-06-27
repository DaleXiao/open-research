import { resolveArxiv } from "../src/parse/arxiv-url.js";
const cases: [string,string|null][] = [
  ["https://arxiv.org/abs/1706.03762","1706.03762"],
  ["https://arxiv.org/html/1706.03762v7","1706.03762v7"],
  ["arxiv.org/pdf/2005.14165","2005.14165"],
  ["1706.03762v7","1706.03762v7"],
  ["cs/0309040","cs/0309040"],
  ["https://example.com/foo",null],
];
let fail=0;
for (const [c,exp] of cases){ const r=resolveArxiv(c); const got=r?r.arxiv_id:null; const ok=got===exp; if(!ok)fail++; console.log(ok?"✓":"✗",c,"->",got); }
console.log(fail===0?"URL PASS ✅":`URL FAIL ${fail}`); process.exit(fail?1:0);
