/**
 * OAuth 2.1 in front of the MCP endpoint, using @cloudflare/workers-oauth-provider.
 *
 * EufyLife has no OAuth of its own, so this Worker is the authorization server. GET /authorize
 * shows a sign-in form; POST /authorize logs in to EufyLife with what the user typed, drops the
 * password, and stores the EufyLife session (token, user id, members) as the grant's encrypted
 * props. The MCP tools read it back from getMcpAuthContext().
 */
import {
  AuthorizationError,
  OAuthProvider,
  type ApprovedConsent,
  type AuthRequest,
  type OAuthHelpers,
} from "@cloudflare/workers-oauth-provider";
import { createMcpHandler } from "agents/mcp/server";

import { EufyError, login } from "./eufy";
import { HTML_HEADERS, htmlResponse, renderErrorPage, renderSignInPage } from "./html";
import { createServer, type GrantProps } from "./mcp";
import {
  ACCESS_TOKEN_TTL_S,
  MIN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  eufyRemainingSeconds,
  grantUserId,
  tokenExchange,
  validateAuthRequest,
} from "./oauth-helpers";

export {
  ACCESS_TOKEN_TTL_S,
  REFRESH_TOKEN_TTL_S,
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

function errorPage(message: string, status: number): Response {
  return htmlResponse(renderErrorPage(message), status);
}

// ---------------------------------------------------------------------------------------------

type SignInPageData = { clientName: string; redirectHost: string; redirectIsLoopback: boolean };

async function pageData(oauth: OAuthHelpers, authRequest: AuthRequest): Promise<SignInPageData> {
  const details = await oauth.describeConsent(authRequest);
  return { clientName: details.clientName, redirectHost: details.redirectHost, redirectIsLoopback: details.redirectIsLoopback };
}

function signInResponse(
  data: SignInPageData,
  consent: { handle: string; headers: Headers },
  extra: { email?: string; country?: string; error?: string; status?: number } = {},
): Response {
  const headers = new Headers(consent.headers);
  for (const [key, value] of Object.entries(HTML_HEADERS)) headers.set(key, value);
  const body = renderSignInPage({
    clientName: data.clientName,
    redirectHost: data.redirectHost,
    redirectIsLoopback: data.redirectIsLoopback,
    handle: consent.handle,
    email: extra.email,
    country: extra.country,
    error: extra.error,
  });
  return new Response(body, { status: extra.status ?? 200, headers });
}

/**
 * GET /authorize: validate the client's request, open a consent transaction (the request is kept
 * server-side; the form only carries a one-time handle bound to this browser by a cookie) and
 * show the sign-in form.
 */
export async function handleAuthorizeGet(request: Request, oauth: OAuthHelpers): Promise<Response> {
  let parsed: AuthRequest;
  try {
    parsed = await oauth.parseAuthRequest(request);
  } catch (error) {
    if (error instanceof AuthorizationError && error.redirectTo) return Response.redirect(error.redirectTo, 302);
    return errorPage("Invalid authorization request.", 400);
  }
  if (!validateAuthRequest(parsed)) {
    return errorPage(
      "Invalid authorization request. This server requires the authorization code flow with PKCE (S256).",
      400,
    );
  }
  let data: SignInPageData;
  try {
    data = await pageData(oauth, parsed); // first: a failed lookup leaves nothing in KV
  } catch {
    return errorPage("Unknown OAuth client.", 400);
  }
  const consent = await oauth.beginConsent(parsed);
  return signInResponse(data, consent, { country: countryHint(request) });
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

/**
 * POST /authorize: redeem the consent handle (this recovers the validated authorization request
 * from storage and checks the browser cookie), sign in to EufyLife with the submitted
 * credentials, and complete the authorization with the resulting session as the grant's props.
 * A failed sign-in opens a fresh transaction and shows the form again.
 */
export async function handleAuthorizePost(request: Request, oauth: OAuthHelpers): Promise<Response> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorPage("Invalid form submission.", 400);
  }
  const handle = formString(form, "handle");
  if (!handle) return errorPage("Invalid form submission.", 400);

  let approved: ApprovedConsent;
  try {
    approved = await oauth.approveConsent(request, handle);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return errorPage("This sign-in page has expired or was already used. Start again from your MCP client.", 400);
    }
    throw error;
  }
  const authRequest = approved.request;
  if (!validateAuthRequest(authRequest)) return errorPage("Invalid authorization request.", 400);
  const data = await pageData(oauth, authRequest);

  const email = formString(form, "email").trim();
  const password = formString(form, "password");
  const country = formString(form, "country").trim().toUpperCase();
  const retry = async (error: string, status: number): Promise<Response> => {
    const consent = await oauth.beginConsent(authRequest);
    // The approval cleared the old binding cookie; the new transaction sets its own.
    for (const value of approved.headers.getSetCookie()) consent.headers.append("Set-Cookie", value);
    return signInResponse(data, consent, { email, country, error, status });
  };

  if (!email || !password) return retry("Enter your EufyLife email and password.", 400);
  if (!/^[A-Z]{2}$/.test(country)) return retry("Country must be a two-letter code such as US or GB.", 400);

  let props: GrantProps;
  try {
    props = await login(email, password, country);
  } catch (error) {
    if (error instanceof EufyError && error.kind === "login_rejected") {
      return retry("EufyLife rejected this email or password. Check them and try again.", 401);
    }
    if (error instanceof EufyError && error.kind === "rate_limited") {
      return retry("EufyLife is rate limiting sign-ins right now. Wait a few minutes and try again.", 429);
    }
    return retry("Could not reach EufyLife. Try again in a moment.", 502);
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
    const headers = new Headers(approved.headers);
    headers.set("Location", redirectTo);
    headers.set("Cache-Control", "no-store");
    return new Response(null, { status: 302, headers });
  } catch (error) {
    console.error({ event: "oauth.complete_authorization_failed", error: error instanceof Error ? error.name : "unknown" });
    return errorPage("Authorization could not be completed. Please try again.", 502);
  }
}

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
