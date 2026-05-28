export interface StandalonePageUrls {
  bindUrl: string | null;
  localUrl: string | null;
}

export function standaloneLoginResponse(args: StandalonePageUrls & { authenticated: boolean }): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taori 登录</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #0d1423;
      --bg2: #132033;
      --card: rgba(255,255,255,0.08);
      --card-border: rgba(255,255,255,0.14);
      --fg: #f8fafc;
      --muted: #cbd5e1;
      --accent: #59c3c3;
      --accent2: #f97316;
      --bad: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
      background:
        radial-gradient(900px 500px at 10% 0%, rgba(89,195,195,0.24), transparent 55%),
        radial-gradient(1000px 640px at 100% 100%, rgba(249,115,22,0.18), transparent 60%),
        linear-gradient(160deg, var(--bg) 0%, var(--bg2) 100%);
      color: var(--fg);
      display: grid;
      place-items: center;
      padding: 24px;
    }
    .shell {
      width: min(480px, 100%);
      padding: 28px;
      border-radius: 24px;
      background: var(--card);
      border: 1px solid var(--card-border);
      backdrop-filter: blur(18px);
      box-shadow: 0 24px 60px rgba(0,0,0,0.35);
    }
    h1 { margin: 0 0 10px; font-size: 30px; }
    p { margin: 0 0 16px; color: var(--muted); line-height: 1.6; }
    form { display: grid; gap: 12px; margin-top: 18px; }
    input {
      width: 100%;
      border: 1px solid rgba(255,255,255,0.12);
      background: rgba(15,23,42,0.4);
      color: var(--fg);
      border-radius: 14px;
      padding: 14px 16px;
      font-size: 15px;
    }
    button {
      border: 0;
      border-radius: 14px;
      padding: 14px 16px;
      font-weight: 600;
      font-size: 15px;
      color: #08111f;
      background: linear-gradient(135deg, var(--accent) 0%, #8be9d0 100%);
      cursor: pointer;
    }
    .meta {
      margin-top: 18px;
      padding-top: 16px;
      border-top: 1px solid rgba(255,255,255,0.12);
      font-size: 13px;
      color: var(--muted);
      display: grid;
      gap: 6px;
    }
    .error {
      display: none;
      margin-top: 10px;
      color: var(--bad);
      font-size: 14px;
    }
    .hint {
      margin-top: 12px;
      font-size: 13px;
      color: var(--muted);
    }
    .ready {
      display: ${args.authenticated ? 'block' : 'none'};
      margin-top: 14px;
      color: #8be9d0;
      font-size: 14px;
    }
  </style>
</head>
<body>
  <div class="shell">
    <h1>Taori Browser Access</h1>
    <p>这是 Taori standalone 的浏览器入口。输入启动服务时设置的访问密码后，即可进入完整 Web 界面。</p>
    <form id="login-form" ${args.authenticated ? 'style="display:none"' : ''}>
      <input id="password" name="password" type="password" placeholder="输入访问密码" autocomplete="current-password" required />
      <button type="submit">登录 Taori</button>
    </form>
    <div class="ready" id="ready-box">已验证，正在进入 Taori…</div>
    <div class="error" id="login-error"></div>
    <div class="hint">脚本和自动化仍可继续使用 Bearer Token 访问 API；浏览器访问建议使用这个登录页。</div>
    <div class="meta">
      ${args.bindUrl ? `<div>Bind: ${escapeHtml(args.bindUrl)}</div>` : ''}
      ${args.localUrl ? `<div>Local: ${escapeHtml(args.localUrl)}</div>` : ''}
      <div>Health: <a href="/health" style="color:#8be9d0">/health</a></div>
    </div>
  </div>
  <script>
    const form = document.getElementById('login-form');
    const errorBox = document.getElementById('login-error');
    const readyBox = document.getElementById('ready-box');
    async function goApp() {
      window.location.replace('/app');
    }
    if (${JSON.stringify(args.authenticated)}) {
      goApp();
    }
    form?.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.style.display = 'none';
      const password = document.getElementById('password').value;
      const response = await fetch('/api/standalone-auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ password })
      });
      if (!response.ok) {
        let message = '登录失败，请检查密码。';
        try {
          const body = await response.json();
          if (body && typeof body.message === 'string') message = body.message;
        } catch {}
        errorBox.textContent = message;
        errorBox.style.display = 'block';
        return;
      }
      readyBox.style.display = 'block';
      goApp();
    });
  </script>
</body>
</html>`;
}

export function standaloneBrowserDisabledResponse(args: StandalonePageUrls): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Taori 浏览器入口未启用</title>
  <style>
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      padding: 24px;
      font-family: Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif;
      background: linear-gradient(160deg, #0f172a 0%, #111827 100%);
      color: #f8fafc;
    }
    .card {
      width: min(560px, 100%);
      padding: 28px;
      border-radius: 22px;
      background: rgba(255,255,255,0.08);
      border: 1px solid rgba(255,255,255,0.12);
    }
    h1 { margin: 0 0 12px; font-size: 28px; }
    p, li { color: #cbd5e1; line-height: 1.7; }
    code { color: #8be9d0; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Taori 浏览器入口未启用</h1>
    <p>当前 standalone 已启动，但你没有设置 <code>--password</code>，所以浏览器 Web UI 登录入口不会开放。</p>
    <p>重新启动示例：</p>
    <p><code>taori --host 0.0.0.0 --port 4101 --password my-secret</code></p>
    <p>你仍然可以直接使用：</p>
    <ul>
      <li><code>/health</code> 做探活</li>
      <li>带 Bearer 的 API 调用做自动化访问</li>
    </ul>
    <p>Bind: ${escapeHtml(args.bindUrl ?? 'n/a')}</p>
    <p>Local: ${escapeHtml(args.localUrl ?? 'n/a')}</p>
  </div>
</body>
</html>`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
