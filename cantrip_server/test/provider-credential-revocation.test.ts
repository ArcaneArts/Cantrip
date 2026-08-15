import { describe, expect, it, vi } from "vitest";

import { OAuthProviderCredentialRevoker } from "../src/models/provider-credential-revocation.js";

describe("provider credential revocation", () => {
  it("uses each provider's published revocation format", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    const revoker = new OAuthProviderCredentialRevoker({
      chatGptClientId: "chatgpt-client",
      chatGptEndpoint: "https://chatgpt.test/oauth/revoke",
      fetch,
      grokClientId: "grok-client",
      grokEndpoint: "https://grok.test/oauth2/revoke",
    });

    await expect(
      revoker.revoke({
        accessToken: "chatgpt-access",
        accountId: "upstream-account",
        email: null,
        expiresAt: null,
        idToken: null,
        kind: "chatgpt",
        planType: null,
        refreshToken: "chatgpt-refresh",
        userId: null,
        version: 1,
      }),
    ).resolves.toBe("revoked");
    await expect(
      revoker.revoke({
        accessToken: "grok-access",
        email: null,
        expiresAt: null,
        kind: "grok",
        planType: null,
        refreshToken: "grok-refresh",
        userId: "grok-user",
        version: 1,
      }),
    ).resolves.toBe("revoked");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "https://chatgpt.test/oauth/revoke",
      expect.objectContaining({
        body: JSON.stringify({
          token: "chatgpt-refresh",
          token_type_hint: "refresh_token",
          client_id: "chatgpt-client",
        }),
        method: "POST",
      }),
    );
    const grokBody = fetch.mock.calls[1]?.[1]?.body;
    expect(String(grokBody)).toBe(
      "client_id=grok-client&token=grok-refresh&token_type_hint=refresh_token",
    );
  });

  it("reduces provider failures to a secret-free status", async () => {
    const secret = "refresh-token-that-must-not-escape";
    const revoker = new OAuthProviderCredentialRevoker({
      fetch: async () => {
        throw new Error(`provider rejected ${secret}`);
      },
    });
    const status = await revoker.revoke({
      accessToken: "access-token",
      accountId: "upstream-account",
      email: null,
      expiresAt: null,
      idToken: null,
      kind: "chatgpt",
      planType: null,
      refreshToken: secret,
      userId: null,
      version: 1,
    });
    expect(status).toBe("failed");
    expect(JSON.stringify(status)).not.toContain(secret);
  });
});
