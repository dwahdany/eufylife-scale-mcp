/** HTML for the sign-in page and the landing page. Every interpolated value is escaped. */

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export const HTML_HEADERS: Record<string, string> = {
  "Content-Type": "text/html; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  // No form-action directive: Chrome applies it to the redirect that follows the form
  // submission, which would block the 302 back to the OAuth client (e.g. claude.ai).
  "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
};

export function htmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: HTML_HEADERS });
}

const STYLES = `
:root { color-scheme: light dark; --fg: #1d1d1f; --bg: #f5f5f7; --card: #fff; --muted: #6e6e73; --accent: #0a7cff; --err-bg: #fde8e8; --err-fg: #8a1c1c; }
@media (prefers-color-scheme: dark) { :root { --fg: #f5f5f7; --bg: #121214; --card: #1e1e21; --muted: #a1a1a6; --err-bg: #3a1a1a; --err-fg: #ffb4b4; } }
* { box-sizing: border-box; }
body { margin: 0; padding: 16px; font: 16px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: var(--fg); background: var(--bg); }
main { max-width: 420px; margin: 6vh auto; background: var(--card); border-radius: 14px; padding: 28px 24px; box-shadow: 0 2px 16px rgba(0,0,0,.08); }
h1 { font-size: 1.35rem; margin: 0 0 12px; }
p { margin: 0 0 14px; }
label { display: block; font-weight: 600; margin: 14px 0 6px; }
input, select { width: 100%; padding: 10px 12px; font: inherit; border: 1px solid #c7c7cc; border-radius: 8px; background: transparent; color: inherit; }
button { width: 100%; margin-top: 20px; padding: 12px; font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; cursor: pointer; }
.hint, .meta { color: var(--muted); font-size: .9rem; }
.error { background: var(--err-bg); color: var(--err-fg); padding: 10px 12px; border-radius: 8px; margin-bottom: 8px; }
code { font-size: .95em; }
`;

export interface SignInPageOptions {
  clientName: string;
  redirectHost: string;
  encodedRequest: string;
  email?: string;
  country?: string;
  error?: string;
}

export function renderSignInPage(options: SignInPageOptions): string {
  const clientName = escapeHtml(options.clientName);
  const redirectHost = escapeHtml(options.redirectHost);
  const encodedRequest = escapeHtml(options.encodedRequest);
  const email = escapeHtml(options.email ?? "");
  const country = escapeHtml((options.country ?? "").toUpperCase());
  const errorBanner = options.error ? `<div class="error" role="alert">${escapeHtml(options.error)}</div>` : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect to EufyLife</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>Connect ${clientName} to your EufyLife scale</h1>
<p class="meta">After signing in you will be sent back to <strong>${redirectHost}</strong>.</p>
${errorBanner}
<form method="post" action="/authorize">
<input type="hidden" name="oauth_request" value="${encodedRequest}">
<label for="email">EufyLife email</label>
<input type="email" id="email" name="email" value="${email}" autocomplete="username" required>
<label for="password">EufyLife password</label>
<input type="password" id="password" name="password" autocomplete="current-password" required>
<label for="country">Country of the account (two letters)</label>
<input type="text" id="country" name="country" value="${country || "US"}" pattern="[A-Za-z]{2}" maxlength="2" autocomplete="country" required>
<button type="submit">Sign in and connect</button>
</form>
<p class="hint">Your email and password are sent to EufyLife once to sign in and are not kept.
Only the session token EufyLife returns is stored, encrypted, for this connection.
It expires after about 30 days, after which you sign in again.</p>
<p class="hint">Signed up with Google or Apple? Set a password in the EufyLife app first.</p>
<p class="hint">This gives read-only access to weight and body-composition data.</p>
</main>
</body>
</html>`;
}

export function renderErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Authorization error</title><style>${STYLES}</style></head><body><main><h1>Authorization error</h1><p>${escapeHtml(message)}</p></main></body></html>`;
}

export function renderLandingPage(mcpUrl: string, repoUrl: string): string {
  const url = escapeHtml(mcpUrl);
  const repo = escapeHtml(repoUrl);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>EufyLife scale MCP</title>
<style>${STYLES}</style>
</head>
<body>
<main>
<h1>EufyLife scale MCP server</h1>
<p>A remote MCP server that gives an AI assistant read-only access to the weight and body
composition recorded by your Eufy smart scale.</p>
<p>Add this URL as a custom connector in Claude (Customize &rarr; Connectors &rarr; Add custom connector), or run
<code>claude mcp add --transport http eufylife ${url}</code> in Claude Code:</p>
<p><code>${url}</code></p>
<p class="hint">You will be asked to sign in with your EufyLife account. The password is used once;
only the session token is stored, encrypted. Source: <a href="${repo}" rel="noreferrer">${repo}</a></p>
</main>
</body>
</html>`;
}
