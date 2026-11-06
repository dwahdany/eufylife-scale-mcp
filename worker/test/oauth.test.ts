import { GrantType, OAuthError, type AuthRequest } from "@cloudflare/workers-oauth-provider";
import { describe, expect, it } from "vitest";

import {
  ACCESS_TOKEN_TTL_S,
  REFRESH_TOKEN_TTL_S,
  eufyRemainingSeconds,
  grantUserId,
  tokenExchange,
  validateAuthRequest,
} from "../src/oauth-helpers";

const request: AuthRequest = {
  responseType: "code",
  clientId: "client-1",
  redirectUri: "https://claude.ai/api/mcp/auth_callback",
  scope: ["mcp"],
  state: "state-123",
  codeChallenge: "abc",
  codeChallengeMethod: "S256",
  resource: "https://example.workers.dev/mcp",
};

describe("validateAuthRequest", () => {
  it("accepts a PKCE S256 code request and rejects downgrades", () => {
    expect(validateAuthRequest(request)).toEqual(request);
    expect(validateAuthRequest({ ...request, codeChallenge: undefined })).toBeNull();
    expect(validateAuthRequest({ ...request, codeChallengeMethod: "plain" })).toBeNull();
    expect(validateAuthRequest({ ...request, responseType: "token" })).toBeNull();
  });
});

describe("token lifetimes follow the EufyLife session", () => {
  const now = 1_000_000;

  it("caps access and refresh tokens to the remaining EufyLife lifetime", () => {
    const props = { expiresAt: now + 2 * 24 * 3600 };
    const code = tokenExchange({ grantType: GrantType.AUTHORIZATION_CODE, props }, now);
    expect(code.accessTokenTTL).toBe(2 * 24 * 3600 - 300);
    expect(code.refreshTokenTTL).toBe(2 * 24 * 3600 - 300);
  });

  it("uses the defaults when EufyLife's token outlives them", () => {
    const props = { expiresAt: now + 31 * 24 * 3600 };
    const code = tokenExchange({ grantType: GrantType.AUTHORIZATION_CODE, props }, now);
    expect(code).toEqual({ accessTokenTTL: ACCESS_TOKEN_TTL_S, refreshTokenTTL: REFRESH_TOKEN_TTL_S });
    const refresh = tokenExchange({ grantType: GrantType.REFRESH_TOKEN, props }, now);
    expect(refresh).toEqual({ accessTokenTTL: ACCESS_TOKEN_TTL_S });
  });

  it("revokes the grant once the EufyLife session is (nearly) over", () => {
    expect(() => tokenExchange({ grantType: GrantType.REFRESH_TOKEN, props: { expiresAt: now + 200 } }, now)).toThrow(OAuthError);
    expect(() => tokenExchange({ grantType: GrantType.REFRESH_TOKEN, props: {} }, now)).toThrow(/expired/);
    expect(eufyRemainingSeconds({ expiresAt: "soon" }, now)).toBe(0);
  });
});

describe("grantUserId", () => {
  it("never contains a colon", () => {
    expect(grantUserId("GB:abc:def")).not.toContain(":");
    expect(grantUserId("2993d907-3a29-4fee-8be7-a14fc7fe854a")).toBe("2993d907-3a29-4fee-8be7-a14fc7fe854a");
    expect(grantUserId("")).toBe("user");
  });
});
