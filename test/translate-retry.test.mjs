// F3-fix2 单测：前端 req() 5xx 分级 + translateAll 批级重试。
// api.ts 自包含（无相对 import，用全局 fetch）→ mock globalThis.fetch 直接测。
// 跑法：npx tsx test/translate-retry.test.mjs
import { ApiError, translate, translateAll, getView } from "../src/lib/api.ts";

let fail = 0;
function check(name, cond, info) {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    fail++;
    console.log(`  ✗ ${name}`, info ?? "");
  }
}

const origFetch = globalThis.fetch;
function mockFetch(handler) {
  globalThis.fetch = (async (url, init) => handler(String(url), init));
}
function jsonRes(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
}
function htmlRes(status) {
  return new Response(`<html><body>${status} error</body></html>`, {
    status,
    headers: { "content-type": "text/html" },
  });
}

console.log("\n=== F3-fix2 req() 5xx 分级 ===");

// ① 503 HTML 错误页 → gateway_error（非 bad_json）
{
  mockFetch(async () => htmlRes(503));
  let err;
  try {
    await getView("x");
  } catch (e) {
    err = e;
  }
  check("503 HTML → ApiError", err instanceof ApiError);
  check("503 HTML → code=gateway_error（非 bad_json）", err?.code === "gateway_error", err?.code);
  check("503 status 保留", err?.status === 503, err?.status);
}

// ② 502/504 HTML → gateway_error
{
  for (const s of [502, 504]) {
    mockFetch(async () => htmlRes(s));
    let err;
    try {
      await getView("x");
    } catch (e) {
      err = e;
    }
    check(`${s} HTML → gateway_error`, err?.code === "gateway_error", err?.code);
  }
}

// ③ 真 bad_json（非 5xx，比如 200 返 HTML）→ 仍 bad_json
{
  mockFetch(async () => new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } }));
  let err;
  try {
    await getView("x");
  } catch (e) {
    err = e;
  }
  check("200 非 JSON → bad_json（保留原分级）", err?.code === "bad_json", err?.code);
}

// ④ 后端返 JSON 但 503 → gateway_error
{
  mockFetch(async () => jsonRes({ error: "busy", code: "x" }, 503));
  let err;
  try {
    await getView("x");
  } catch (e) {
    err = e;
  }
  check("JSON 503 → gateway_error", err?.code === "gateway_error", err?.code);
}

console.log("\n=== F3-fix2 translateAll 批级重试 ===");

// ⑤ 单批 503 → 重试后成功
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    // 第 1 次 503，第 2 次成功（无 more）
    if (calls === 1) return htmlRes(503);
    return jsonRes({ translated: [{ block_id: "b1", text_zh: "译", model: "m", degraded: false }], cached_hit: 0, skipped_untranslatable: 0, remaining: 0, has_more: false, failed: [] });
  });
  const batches = [];
  const total = await translateAll("p1", (r, t) => batches.push(t), { retriesPerBatch: 3 });
  check("503 重试后成功（calls=2）", calls === 2, calls);
  check("total=1", total === 1, total);
  check("onBatch 调用一次（重试不重复回调）", batches.length === 1, batches.length);
}

// ⑥ 重试仍败 → 抛 gateway_error（调用方据 total 报部分成功）
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return htmlRes(503); // 永远 503
  });
  let err;
  const t0 = Date.now();
  try {
    await translateAll("p1", () => {}, { retriesPerBatch: 2 });
  } catch (e) {
    err = e;
  }
  check("重试耗尽 → 抛 ApiError", err instanceof ApiError, err);
  check("→ gateway_error", err?.code === "gateway_error", err?.code);
  check("重试 2 次（共 3 次调用）", calls === 3, calls);
  // 退避确实等待了（0.8s + 1.6s ≈ 2.4s 起）
  check("有指数退避（≥2s）", Date.now() - t0 >= 2000, Date.now() - t0);
}

// ⑦ 多批：第 1 批 has_more，第 2 批完成；中间一次 503 重试
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    if (calls === 1) return jsonRes({ translated: [{ block_id: "b1", text_zh: "译", model: "m", degraded: false }], cached_hit: 0, skipped_untranslatable: 0, remaining: 1, has_more: true, failed: [] });
    if (calls === 2) return htmlRes(503); // 第 2 批先 503
    return jsonRes({ translated: [{ block_id: "b2", text_zh: "译", model: "m", degraded: false }], cached_hit: 1, skipped_untranslatable: 0, remaining: 0, has_more: false, failed: [] });
  });
  const totals = [];
  const total = await translateAll("p1", (r, t) => totals.push(t), { retriesPerBatch: 3 });
  check("多批+重试 total=2", total === 2, total);
  check("onBatch 两次（批1+批2成功，重试不算）", totals.length === 2, totals.length);
  check("累计进度递增 [1,2]", totals[0] === 1 && totals[1] === 2, totals);
}

// ⑧ 非可恢复错（如 404）不重试，直接抛
{
  let calls = 0;
  mockFetch(async () => {
    calls++;
    return jsonRes({ error: "paper 未导入", code: "not_found" }, 404);
  });
  let err;
  try {
    await translateAll("p1", () => {}, { retriesPerBatch: 3 });
  } catch (e) {
    err = e;
  }
  check("404 不重试（calls=1）", calls === 1, calls);
  check("404 直接抛", err instanceof ApiError && err.status === 404, err?.status);
}

globalThis.fetch = origFetch;
console.log(fail ? `\nF3-fix2 retry: ${fail} CHECK(S) FAILED ✗` : "\nF3-fix2 retry: ALL PASS ✅");
process.exit(fail ? 1 : 0);
