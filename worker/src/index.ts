/**
 * Worker entry point. Routes:
 *   GET  /               landing page with connection instructions
 *   GET  /health         liveness probe
 *   *    /mcp            the MCP endpoint (bearer token required; OAuth challenge otherwise)
 *   /authorize, /token, /register, /.well-known/*   OAuth 2.1 (see oauth.ts)
 */
import type { OAuthProvider } from "@cloudflare/workers-oauth-provider";

import { htmlResponse, renderLandingPage } from "./html";
import { MCP_PATH, createProvider, type Env } from "./oauth";

const REPO_URL = "https://github.com/dwahdany/eufylife-scale-mcp";

const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(request: Request, env: Env): { provider: OAuthProvider<Env>; resource: string } {
  const configured = env.MCP_RESOURCE?.trim();
  const resource = configured || `${new URL(request.url).origin}${MCP_PATH}`;
  let provider = providers.get(resource);
  if (!provider) {
    provider = createProvider(resource);
    providers.set(resource, provider);
  }
  return { provider, resource };
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "ok" }), {
        headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
      });
    }
    const { provider, resource } = providerFor(request, env);
    if (url.pathname === "/" && request.method === "GET") {
      return htmlResponse(renderLandingPage(resource, REPO_URL));
    }
    return provider.fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
