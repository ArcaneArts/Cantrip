import { describe, expect, it } from "vitest";

import { ProviderCredentialIdentityConflictError } from "../src/db/repository.js";
import { GrokCredentialRefresher } from "../src/models/grok-credential-refresher.js";
import { ProviderCredentialRequiresSignInError } from "../src/models/provider-access-tokens.js";
import type { GrokProviderCredential } from "../src/models/provider-credentials.js";

const now = Date.UTC(2026, 7, 15, 12);

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function credential(): GrokProviderCredential {
  return {
    accessToken: "old-access-token",
    email: "old@example.test",
    expiresAt: now + 60_000,
    kind: "grok",
    planType: "SuperGrok",
    refreshToken: "server-only-refresh-token",
    userId: "user-one",
    version: 1,
  };
}

describe("Grok credential refresher", () => {
  it("persists refresh-token rotation and validated identity metadata", async () => {
    const requests: Array<{ body: string; headers: Headers }> = [];
    const accessToken = jwt({ exp: 1_800_000_000 });
    const refresher = new GrokCredentialRefresher({
      endpoint: "https://auth.example.test/oauth2/token",
      now: () => now,
      fetch: async (_input, init) => {
        requests.push({
          body: String(init?.body),
          headers: new Headers(init?.headers),
        });
        return Response.json({
          access_token: accessToken,
          id_token: jwt({ email: "new@example.test", sub: "user-one" }),
          refresh_token: "rotated-refresh-token",
        });
      },
    });

    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).resolves.toEqual({
      accessToken,
      email: "new@example.test",
      expiresAt: 1_800_000_000_000,
      kind: "grok",
      planType: "SuperGrok",
      refreshToken: "rotated-refresh-token",
      userId: "user-one",
      version: 1,
    });
    expect(requests).toEqual([
      {
        body: new URLSearchParams({
          client_id: "b1a00492-073a-47ea-816f-4c329264a828",
          grant_type: "refresh_token",
          refresh_token: "server-only-refresh-token",
        }).toString(),
        headers: new Headers({
          "content-type": "application/x-www-form-urlencoded",
        }),
      },
    ]);
  });

  it("quarantines an identity change in a refreshed identity token", async () => {
    const refresher = new GrokCredentialRefresher({
      fetch: async () =>
        Response.json({
          access_token: "new-access-token",
          expires_in: 3_600,
          id_token: jwt({ sub: "user-two" }),
        }),
    });
    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderCredentialIdentityConflictError);
  });

  it("classifies invalid grants without exposing OAuth response details", async () => {
    const leakedCandidate = "server-only-refresh-token";
    const refresher = new GrokCredentialRefresher({
      fetch: async () =>
        Response.json(
          { error: "invalid_grant", error_description: leakedCandidate },
          { status: 400 },
        ),
    });
    let error: unknown;
    try {
      await refresher.refresh(credential(), new AbortController().signal);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ProviderCredentialRequiresSignInError);
    expect(String(error)).not.toContain(leakedCandidate);
  });

  it("treats an unauthorized malformed response as requiring sign-in", async () => {
    const refresher = new GrokCredentialRefresher({
      fetch: async () => new Response("not-json", { status: 401 }),
    });
    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderCredentialRequiresSignInError);
  });
});
