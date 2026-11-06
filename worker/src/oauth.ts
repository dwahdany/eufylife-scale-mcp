/**
 * OAuth 2.1 in front of the MCP endpoint, using @cloudflare/workers-oauth-provider.
 *
 * EufyLife has no OAuth of its own, so this Worker is the authorization server. GET /authorize
 * shows a sign-in form; POST /authorize logs in to EufyLife with what the user typed, drops the
 * password, and stores the EufyLife session (token, user id, members) as the grant's encrypted
 * props. The MCP tools read it back from getMcpAuthContext().
 */
import { OAuthProvider, type AuthRequest, type OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { EufyError, login } from "./eufy";
import { htmlResponse, renderErrorPage, renderSignInPage } from "./html";
import { createServer, type GrantProps } from "./mcp";
import {
  ACCESS_TOKEN_TTL_S,
  MIN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  decodeAuthRequest,
  encodeAuthRequest,
  eufyRemainingSeconds,
  grantUserId,
  tokenExchange,
  validateAuthRequest,
} from "./oauth-helpers";

export {
  ACCESS_TOKEN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  decodeAuthRequest,
  encodeAuthRequest,
  eufyRemainingSeconds,
  grantUserId,
  tokenExchange,
  validateAuthRequest,
} from "./oauth-helpers";

export const MCP_PATH = "/mcp";
export const AUTHORIZE_PATH = "/authorize";
export const TOKEN_PATH = "/token";
export const REGISTER_PATH = "/register";

export interface Env {
  OAUTH_KV: KVNamespace;
  /** Exact URL MCP clients connect to. Empty: derived from the request origin. */
  MCP_RESOURCE?: string;
}

function redirectHostOf(authRequest: AuthRequest): string {
  try {
    return new URL(authRequest.redirectUri).host;
  } catch {
    return authRequest.redirectUri;
  }
}

function errorPage(message: string, status: number): Response {
  return htmlResponse(renderErrorPage(message), status);
}

// ---------------------------------------------------------------------------------------------

export async function handleAuthorizeGet(request: Request, oauth: OAuthHelpers): Promise<Response> {
  let parsed: AuthRequest;
  try {
    parsed = await oauth.parseAuthRequest(request);
  } catch {
    return errorPage("Invalid authorization request.", 400);
  }
  const authRequest = validateAuthRequest(parsed);
  if (!authRequest) {
    return errorPage(
      "Invalid authorization request. This server requires the authorization code flow with PKCE (S256).",
      400,
    );
  }
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return errorPage("Unknown OAuth client.", 400);
  return htmlResponse(
    renderSignInPage({
      clientName: client.clientName?.trim() || client.clientId,
      redirectHost: redirectHostOf(authRequest),
      encodedRequest: encodeAuthRequest(authRequest),
      country: countryHint(request),
    }),
  );
}

/** Best guess for the account country from Cloudflare's geolocation, for the form default. */
function countryHint(request: Request): string {
  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const country = cf?.country;
  return typeof country === "string" && /^[A-Z]{2}$/.test(country) ? country : "US";
}

function formString(form: FormData, key: string): string {
  const value = form.get(key);
  return typeof value === "string" ? value : "";
}

export async function handleAuthorizePost(request: Request, oauth: OAuthHelpers): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage("Invalid form submission.", 400);
  }
  const encodedRequest = formString(form, "oauth_request");
  const authRequest = encodedRequest ? decodeAuthRequest(encodedRequest) : null;
  if (!authRequest) return errorPage("Invalid authorization request.", 400);
  const client = await oauth.lookupClient(authRequest.clientId);
  if (!client) return errorPage("Unknown OAuth client.", 400);

  const email = formString(form, "email").trim();
  const password = formString(form, "password");
  const country = formString(form, "country").trim().toUpperCase();
  const rerender = (error: string, status: number): Response =>
    htmlResponse(
      renderSignInPage({
        clientName: client.clientName?.trim() || client.clientId,
        redirectHost: redirectHostOf(authRequest),
        encodedRequest,
        email,
        country,
        error,
      }),
      status,
    );

  if (!email || !password) return rerender("Enter your EufyLife email and password.", 400);
  if (!/^[A-Z]{2}$/.test(country)) return rerender("Country must be a two-letter code such as US or GB.", 400);

  let props: GrantProps;
  try {
    props = await login(email, password, country);
  } catch (error) {
    if (error instanceof EufyError) {
      switch (error.kind) {
        case "login_rejected":
          return rerender("EufyLife rejected this email or password. Check them and try again.", 401);
        case "rate_limited":
          return rerender("EufyLife is rate limiting sign-ins right now. Wait a few minutes and try again.", 429);
        default:
          return rerender("Could not reach EufyLife. Try again in a moment.", 502);
      }
    }
    return rerender("Could not reach EufyLife. Try again in a moment.", 502);
  }

  try {
    const { redirectTo } = await oauth.completeAuthorization({
      request: authRequest,
      userId: grantUserId(props.userId),
      // Stored in the clear for grant listings: keep it free of personal data.
      metadata: { country: props.country },
      scope: authRequest.scope,
      props,
    });
    return new Response(null, { status: 302, headers: { Location: redirectTo, "Cache-Control": "no-store" } });
  } catch (error) {
    console.error({ event: "oauth.complete_authorization_failed", error: error instanceof Error ? error.name : "unknown" });
    return errorPage("Authorization could not be completed. Please try again.", 502);
  }
}

// ---------------------------------------------------------------------------------------------

function unauthorized(request: Request, description: string): Response {
  const url = new URL(request.url);
  const metadataUrl = `${url.origin}/.well-known/oauth-protected-resource${url.pathname}`;
  return new Response("Unauthorized", {
    status: 401,
    headers: {
      "WWW-Authenticate": `Bearer error="invalid_token", error_description="${description}", resource_metadata="${metadataUrl}"`,
    },
  });
}

/** One OAuthProvider per canonical resource URL (there is normally exactly one). */
export function createProvider(resource: string): OAuthProvider<Env> {
  const resourceHost = new URL(resource).hostname;
  const mcpHandler = createMcpHandler(createServer, { route: MCP_PATH, allowedHostnames: [resourceHost] });

  const apiHandler = {
    fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
      const props = (ctx as ExecutionContext & { props?: unknown }).props;
      if (eufyRemainingSeconds(props) < MIN_TTL_S) {
        return Promise.resolve(unauthorized(request, "The EufyLife session behind this grant has expired"));
      }
      return mcpHandler(request, env, ctx);
    },
  };

  const defaultHandler = {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      if (url.pathname !== AUTHORIZE_PATH) return new Response("Not found", { status: 404 });
      // The provider injects its helpers into env before calling us.
      const oauth = (env as Env & { OAUTH_PROVIDER: OAuthHelpers }).OAUTH_PROVIDER;
      if (request.method === "GET") return handleAuthorizeGet(request, oauth);
      if (request.method === "POST") return handleAuthorizePost(request, oauth);
      return new Response("Method not allowed", { status: 405, headers: { Allow: "GET, POST" } });
    },
  };

  return new OAuthProvider<Env>({
    apiRoute: MCP_PATH,
    apiHandler,
    defaultHandler,
    authorizeEndpoint: AUTHORIZE_PATH,
    tokenEndpoint: TOKEN_PATH,
    clientRegistrationEndpoint: REGISTER_PATH,
    scopesSupported: ["mcp"],
    accessTokenTTL: ACCESS_TOKEN_TTL_S,
    refreshTokenTTL: REFRESH_TOKEN_TTL_S,
    clientIdMetadataDocumentEnabled: true,
    tokenExchangeCallback: (options) => tokenExchange(options),
    resourceMetadata: { resource, resource_name: "EufyLife scale MCP server" },
  });
}
