// research auth middleware — terminal-style login (cookie session)
// 照搬 an internal reference project functions/_middleware.js（ 防 API 白嫖）。
// Credentials & secret read from CF Pages env vars: USERS_JSON, SESSION_SECRET
// 注意：research.example.com/api/* 走独立 Worker route（research-worker），
//       Pages Functions middleware **不拦截** worker-route 路径，故 /api/* 的鉴权
//       由 research-worker 入口同款 Basic-Auth 门禁负责（共用 USERS_JSON/SESSION_SECRET）。
//       本 middleware 守护前端页面 + 同源 cookie/Basic 登录态。

const COOKIE_NAME = 'research_session';
const SESSION_MAX_AGE = 604800; // 7 days

function loginPage(error) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>research</title>
<style>
  /* macOS-style login, mirrors an internal reference project common.css */
  :root {
    --bg:        #0a0a0a;
    --bg-raised: #111;
    --bg-sunk:   #050505;
    --border:    #1f1f1f;
    --border-strong: #2a2a2a;
    --text:      #e0e0e0;
    --muted:     #666;
    --accent:    #4ade80;
    --accent-strong: #86efac;
    --accent-dim:    #22c55e;
    --danger:    #f87171;
    --caret:     #4ade80;
    --radius: 4px;
    --mono: 'Geist Mono', 'SF Mono', 'Fira Code', 'JetBrains Mono', ui-monospace, Menlo, Consolas, monospace;
    --shadow-2: 0 8px 40px rgba(0,0,0,0.65);
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--mono);
    font-size: 14px;
    background: var(--bg);
    color: var(--text);
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    caret-color: var(--caret);
  }
  ::selection { background: var(--accent); color: #0a0a0a; }

  .auth-page {
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
  }
  .auth-card {
    position: relative;
    width: 100%;
    max-width: 440px;
    background: var(--bg-raised);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    box-shadow: var(--shadow-2);
    padding: 68px 32px 32px;
  }
  .auth-card::before {
    content: "";
    position: absolute;
    top: 0; left: 0; right: 0;
    height: 28px;
    background: #161616;
    border-bottom: 1px solid var(--border);
    border-radius: var(--radius) var(--radius) 0 0;
  }
  .auth-card::after {
    content: "";
    position: absolute;
    top: 10px; left: 14px;
    width: 10px; height: 10px;
    border-radius: 50%;
    background: #ff5f56;
    box-shadow: 18px 0 0 #ffbd2e, 36px 0 0 #27c93f;
  }

  .auth-head { text-align: left; margin-bottom: 24px; }
  .auth-head h1 {
    font-size: 1.1rem;
    margin: 0 0 4px 0;
    font-weight: 500;
    color: var(--text);
    letter-spacing: 0;
  }
  .auth-head h1::before { content: "❯ "; color: var(--accent); font-weight: 600; }
  .auth-head .muted { margin: 0; color: var(--muted); font-size: 0.82rem; }

  form { display: flex; flex-direction: column; gap: 14px; }
  form label { display: flex; flex-direction: column; gap: 4px; }
  form label > span {
    font-size: 0.78rem;
    color: var(--muted);
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  form input[type="text"],
  form input[type="password"] {
    background: var(--bg-sunk);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 9px 12px;
    color: var(--text);
    font: inherit;
    outline: none;
    caret-color: var(--caret);
    transition: border-color 0.1s, box-shadow 0.1s;
  }
  form input::placeholder { color: #333; }
  form input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 2px rgba(74, 222, 128, 0.12);
  }
  form input:-webkit-autofill,
  form input:-webkit-autofill:hover,
  form input:-webkit-autofill:focus {
    -webkit-text-fill-color: var(--text);
    -webkit-box-shadow: 0 0 0 1000px var(--bg-sunk) inset;
    transition: background-color 5000s ease-in-out 0s;
    caret-color: var(--caret);
  }

  .btn {
    font: inherit;
    font-size: 0.88rem;
    padding: 8px 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border-strong);
    background: var(--bg-sunk);
    color: var(--text);
    cursor: pointer;
    transition: background 0.1s, border-color 0.1s, color 0.1s;
  }
  .btn.primary {
    background: transparent;
    border-color: var(--accent);
    color: var(--accent);
    font-weight: 500;
  }
  .btn.primary:hover:not(:disabled) {
    background: rgba(74,222,128,0.08);
    border-color: var(--accent-strong);
    color: var(--accent-strong);
  }
  .btn:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px rgba(74,222,128,0.25);
  }
  .btn:active:not(:disabled) { transform: translateY(1px); }

  .form-error {
    background: transparent;
    border: 1px solid var(--danger);
    color: var(--danger);
    padding: 8px 12px;
    border-radius: var(--radius);
    font-size: 0.85rem;
    margin: 0;
  }
  .form-error::before { content: "! "; color: var(--danger); font-weight: 600; }

  footer { text-align: center; padding: 1.5rem 0 1rem; font-size: 0.7rem; color: var(--muted); }
  footer a { color: var(--muted); text-decoration: none; }
  footer a:hover { color: var(--accent); }
</style>
</head>
<body class="auth-page">
<main class="auth-card">
  <header class="auth-head">
    <h1>research</h1>
    <p class="muted">Sign in to continue.</p>
  </header>
  ${error ? '<p class="form-error">' + error + '</p>' : ''}
  <form method="POST" action="/__auth/login">
    <label>
      <span>User</span>
      <input type="text" name="user" autocomplete="username" autofocus required>
    </label>
    <label>
      <span>Password</span>
      <input type="password" name="pass" autocomplete="current-password" required>
    </label>
    <button class="btn primary" type="submit">Sign in</button>
  </form>
  <footer>
    <a href="https://example.com" target="_blank" rel="noopener">Tinker Lab / 折腾实验室</a>
  </footer>
</main>
</body>
</html>`;
}

function parseCookie(cookieHeader, name) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]*)'));
  return match ? match[1] : null;
}

async function makeToken(secret, timestamp) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(timestamp));
  return timestamp + '.' + btoa(String.fromCharCode(...new Uint8Array(sig))).replace(/=/g, '');
}

async function verifyToken(secret, token) {
  if (!token) return false;
  const dot = token.indexOf('.');
  if (dot === -1) return false;
  const ts = token.slice(0, dot);
  const age = Date.now() - parseInt(ts, 10);
  if (isNaN(age) || age < 0 || age > SESSION_MAX_AGE * 1000) return false;
  const expected = await makeToken(secret, ts);
  return token === expected;
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Read auth config from env (Pages env vars). Fail closed if missing.
  let USERS, SESSION_SECRET;
  try {
    USERS = JSON.parse(env.USERS_JSON);
    SESSION_SECRET = env.SESSION_SECRET;
    if (!USERS || !SESSION_SECRET) throw new Error('missing');
  } catch (e) {
    return new Response('Auth not configured', { status: 503 });
  }

  // Allow favicon through without auth
  if (url.pathname === '/favicon.png' || url.pathname === '/favicon.ico') {
    return context.next();
  }

  // Handle login POST
  if (request.method === 'POST' && url.pathname === '/__auth/login') {
    const form = await request.formData();
    const user = form.get('user');
    const pass = form.get('pass');
    if (USERS[user] === pass) {
      const ts = Date.now().toString();
      const token = await makeToken(SESSION_SECRET, ts);
      return new Response('', {
        status: 302,
        headers: {
          'Location': '/',
          'Set-Cookie': `${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MAX_AGE}`,
        },
      });
    }
    return new Response(loginPage('Invalid credentials'), {
      status: 401,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }

  // Handle logout
  if (url.pathname === '/__auth/logout') {
    return new Response('', {
      status: 302,
      headers: {
        'Location': '/',
        'Set-Cookie': `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`,
        'Cache-Control': 'no-store',
      },
    });
  }

  // Check session cookie
  const cookie = parseCookie(request.headers.get('Cookie'), COOKIE_NAME);
  const valid = await verifyToken(SESSION_SECRET, cookie);

  // Also accept Basic Auth (for API/curl access)
  if (!valid) {
    const auth = request.headers.get('Authorization');
    if (auth && auth.startsWith('Basic ')) {
      try {
        const decoded = atob(auth.slice(6));
        const idx = decoded.indexOf(':');
        if (idx !== -1 && USERS[decoded.slice(0, idx)] === decoded.slice(idx + 1)) {
          return context.next();
        }
      } catch {}
    }
  }

  if (!valid) {
    return new Response(loginPage(''), {
      status: 200,
      headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
    });
  }

  const resp = await context.next();
  const newResp = new Response(resp.body, resp);
  newResp.headers.set('Cache-Control', 'no-store');
  return newResp;
}
