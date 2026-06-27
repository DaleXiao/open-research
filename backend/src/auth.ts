// research-worker 入口鉴权（防 API 白嫖）。
// research.example.com/api/* 走独立 Worker route，Pages Functions middleware 不拦截，
// 故 worker 入口必须自带同款鉴权，与 Pages 共享 USERS_JSON / SESSION_SECRET。
//
// 接受两种凭据（与 functions/_middleware.js 完全一致的 HMAC token 方案）：
//   1. Cookie: research_session=<ts.sig>（浏览器登录后同域自动带上）
//   2. Authorization: Basic base64(user:pass)（curl / 程序化访问）
//
// 凭据零明文进 git：USERS_JSON / SESSION_SECRET 由 wrangler secret 注入。

const COOKIE_NAME = "research_session";
const SESSION_MAX_AGE = 604800; // 7d，与 middleware 对齐

export interface AuthEnv {
  /** wrangler secret：JSON，如 {"alice":"<password>"}。缺失则 fail-closed 503。 */
  USERS_JSON?: string;
  /** wrangler secret：HMAC 签名密钥，与 Pages middleware 同值（cookie 互通）。 */
  SESSION_SECRET?: string;
}

function parseCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp("(?:^|;\\s*)" + name + "=([^;]*)"));
  return match ? match[1] : null;
}

async function makeToken(secret: string, timestamp: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(timestamp));
  return timestamp + "." + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, "");
}

async function verifyToken(secret: string, token: string | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot === -1) return false;
  const ts = token.slice(0, dot);
  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE * 1000) return false;
  const expected = await makeToken(secret, ts);
  // 长度相等再比，constant-ish；token 非用户可控长度，足够。
  return token === expected;
}

/**
 * 鉴权检查。返回 null = 通过；返回 Response = 拒绝（401/503，调用方直接返回）。
 * fail-closed：env 缺 USERS_JSON / SESSION_SECRET → 503，绝不放行。
 */
export async function checkAuth(req: Request, env: AuthEnv): Promise<Response | null> {
  let USERS: Record<string, string>;
  let secret: string;
  try {
    USERS = JSON.parse(env.USERS_JSON || "");
    secret = env.SESSION_SECRET || "";
    if (!USERS || typeof USERS !== "object" || !secret) throw new Error("missing");
  } catch {
    return new Response(JSON.stringify({ error: "auth_not_configured" }), {
      status: 503,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  // 1. session cookie（浏览器登录态，与 Pages middleware 互通）
  const cookie = parseCookie(req.headers.get("Cookie"), COOKIE_NAME);
  if (await verifyToken(secret, cookie)) return null;

  // 2. Basic Auth（curl / 程序化）
  const auth = req.headers.get("Authorization");
  if (auth && auth.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6));
      const idx = decoded.indexOf(":");
      if (idx !== -1 && USERS[decoded.slice(0, idx)] === decoded.slice(idx + 1)) {
        return null;
      }
    } catch {
      /* fallthrough → 401 */
    }
  }

  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Basic realm="research"',
    },
  });
}
