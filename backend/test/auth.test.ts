// research-worker 入口鉴权单测（离线，无网络）。
// 覆盖：fail-closed(503) / 无凭据 401 / Basic 正确放行 / Basic 错误 401 / cookie token 互通 / 过期 token 拒。
import { checkAuth } from "../src/auth.js";

const SECRET = "test-secret-xyz";
const USERS_JSON = JSON.stringify({ alice: "pw123" });
const env = { USERS_JSON, SESSION_SECRET: SECRET };

let pass = 0;
let fail = 0;
function ok(name: string, cond: boolean) {
  if (cond) {
    pass++;
    console.log(`  ✅ ${name}`);
  } else {
    fail++;
    console.log(`  ❌ ${name}`);
  }
}

function req(headers: Record<string, string> = {}): Request {
  return new Request("https://research.example.com/api/paper/x/qa", { method: "POST", headers });
}

// 复刻 middleware/auth.ts 的 token 生成（用于 cookie 互通测试）
async function makeToken(secret: string, ts: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(ts));
  return ts + "." + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "");
}

async function main() {
  // 1. fail-closed：缺 secret → 503
  {
    const r = await checkAuth(req(), { USERS_JSON } as any);
    ok("缺 SESSION_SECRET → 503 fail-closed", r !== null && r.status === 503);
  }
  {
    const r = await checkAuth(req(), { SESSION_SECRET: SECRET } as any);
    ok("缺 USERS_JSON → 503 fail-closed", r !== null && r.status === 503);
  }

  // 2. 无凭据 → 401
  {
    const r = await checkAuth(req(), env);
    ok("无 cookie/Basic → 401", r !== null && r.status === 401);
    ok("401 带 WWW-Authenticate", r !== null && (r.headers.get("www-authenticate") || "").includes("Basic"));
  }

  // 3. Basic 正确 → 放行(null)
  {
    const basic = "Basic " + btoa("alice:pw123");
    const r = await checkAuth(req({ Authorization: basic }), env);
    ok("Basic alice:pw123 → 放行(null)", r === null);
  }

  // 4. Basic 错误密码 → 401
  {
    const basic = "Basic " + btoa("alice:wrong");
    const r = await checkAuth(req({ Authorization: basic }), env);
    ok("Basic 错误密码 → 401", r !== null && r.status === 401);
  }
  // 4b. Basic 未知用户 → 401
  {
    const basic = "Basic " + btoa("eve:pw123");
    const r = await checkAuth(req({ Authorization: basic }), env);
    ok("Basic 未知用户 → 401", r !== null && r.status === 401);
  }

  // 5. cookie token 互通（Pages 登录后 worker 也认）
  {
    const tok = await makeToken(SECRET, Date.now().toString());
    const r = await checkAuth(req({ Cookie: `research_session=${tok}` }), env);
    ok("有效 research_session cookie → 放行(null)", r === null);
  }
  // 5b. 过期 token → 401
  {
    const oldTs = (Date.now() - 8 * 86400 * 1000).toString(); // 8d > 7d
    const tok = await makeToken(SECRET, oldTs);
    const r = await checkAuth(req({ Cookie: `research_session=${tok}` }), env);
    ok("过期 cookie token → 401", r !== null && r.status === 401);
  }
  // 5c. 错误 secret 签的 token → 401
  {
    const tok = await makeToken("wrong-secret", Date.now().toString());
    const r = await checkAuth(req({ Cookie: `research_session=${tok}` }), env);
    ok("错误 secret 签的 token → 401", r !== null && r.status === 401);
  }

  console.log(`\nAUTH TESTS: ${pass} pass / ${fail} fail`);
  if (fail > 0) process.exit(1);
}

main();
