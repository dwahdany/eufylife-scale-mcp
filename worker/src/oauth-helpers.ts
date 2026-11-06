/**
 * Pure helpers for the OAuth layer, kept free of Workers-runtime imports so they can be unit
 * tested in Node. See oauth.ts for how they are used.
 */
import { GrantType, OAuthError, type AuthRequest, type TokenExchangeCallbackOptions, type TokenExchangeCallbackResult } from "@cloudflare/workers-oauth-provider";
import { z } from "zod";

// Tokens are persisted in KV, and every refresh writes the grant plus a new access token.
// Long-lived sessions keep a personal deployment far below the KV free plan's write quota.
export const ACCESS_TOKEN_TTL_S = 7 * 24 * 3600;
export const REFRESH_TOKEN_TTL_S = 30 * 24 * 3600;
/** KV refuses expirations under 60 s; treat anything shorter as already expired. */
export const MIN_TTL_S = 60;
/** Stop handing out tokens this long before EufyLife's own expiry, like the Python client. */
const EUFY_EXPIRY_MARGIN_S = 300;

// ---------------------------------------------------------------------------------------------
// The authorization request travels through the form in one hidden field, base64url-encoded.
// It is validated again on the way back, so a tampered or downgraded request is refused.

const authRequestSchema = z.looseObject({
  responseType: z.literal("code"),
  clientId: z.string().min(1),
  redirectUri: z.string().min(1),
  scope: z.array(z.string()),
  state: z.string(),
  // PKCE S256 is mandatory for MCP clients. Without a stored challenge the provider would let
  // the code be redeemed without a verifier.
  codeChallenge: z.string().min(1),
  codeChallengeMethod: z.literal("S256"),
  resource: z.string().optional(),
  issuer: z.string().optional(),
});

export function validateAuthRequest(value: unknown): AuthRequest | null {
  const result = authRequestSchema.safeParse(value);
  return result.success ? (result.data as AuthRequest) : null;
}

export function encodeAuthRequest(authRequest: AuthRequest): string {
  const bytes = new TextEncoder().encode(JSON.stringify(authRequest));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function decodeAuthRequest(encoded: string): AuthRequest | null {
  let parsed: unknown;
  try {
    const base64 = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  return validateAuthRequest(parsed);
}


/** Sanitise an EufyLife user id for use as the OAuth userId (which must not contain ':'). */
export function grantUserId(eufyUserId: string): string {
  return encodeURIComponent(eufyUserId).replaceAll(":", "%3A") || "user";
}

/** Seconds the EufyLife session is still good for, after our safety margin. */
export function eufyRemainingSeconds(props: unknown, nowSeconds = Math.floor(Date.now() / 1000)): number {
  const expiresAt = (props as { expiresAt?: unknown } | null | undefined)?.expiresAt;
  if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) return 0;
  return Math.floor(expiresAt) - EUFY_EXPIRY_MARGIN_S - nowSeconds;
}

/**
 * Cap OAuth token lifetimes to the EufyLife session behind them. EufyLife has no refresh
 * endpoint, so once its token runs out the only way forward is a new sign-in: revoking the grant
 * makes the MCP client re-authorize instead of hitting a dead session.
 */
export function tokenExchange(
  options: Pick<TokenExchangeCallbackOptions, "grantType" | "props">,
  nowSeconds = Math.floor(Date.now() / 1000),
): TokenExchangeCallbackResult {
  const remaining = eufyRemainingSeconds(options.props, nowSeconds);
  if (remaining < MIN_TTL_S) {
    throw new OAuthError("invalid_grant", { description: "The EufyLife session behind this grant has expired. Sign in again." });
  }
  const result: TokenExchangeCallbackResult = { accessTokenTTL: Math.min(ACCESS_TOKEN_TTL_S, remaining) };
  if (options.grantType === GrantType.AUTHORIZATION_CODE) {
    result.refreshTokenTTL = Math.min(REFRESH_TOKEN_TTL_S, remaining);
  }
  return result;
}

