import { describe, expect, it } from "vitest";

import { ProviderCredentialIdentityConflictError } from "../src/db/repository.js";
import { ChatGptCredentialRefresher } from "../src/models/chatgpt-credential-refresher.js";
import { ProviderCredentialRequiresSignInError } from "../src/models/provider-access-tokens.js";
import type { ChatGptProviderCredential } from "../src/models/provider-credentials.js";

const now = Date.UTC(2026, 7, 15, 12);

function jwt(claims: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "signature",
  ].join(".");
}

function credential(): ChatGptProviderCredential {
  return {
    accessToken: "old-access-token",
    accountId: "workspace-one",
    email: "old@example.test",
    expiresAt: now + 60_000,
    idToken: "old-id-token",
    kind: "chatgpt",
    planType: "plus",
    refreshToken: "server-only-refresh-token",
    userId: "user-one",
    version: 1,
  };
}

describe("ChatGPT credential refresher", () => {
  it("persists rotated tokens and validated identity metadata", async () => {
    const requests: Array<{ body: unknown; headers: Headers }> = [];
    const accessToken = jwt({
      exp: 1_800_000_000,
      "https://api.openai.com/auth": {
        chatgpt_account_id: "workspace-one",
        chatgpt_plan_type: "pro",
        chatgpt_user_id: "user-one",
      },
    });
    const idToken = jwt({ email: "new@example.test" });
    const refresher = new ChatGptCredentialRefresher({
      endpoint: "https://auth.example.test/oauth/token",
      now: () => now,
      fetch: async (_input, init) => {
        requests.push({
          body: JSON.parse(String(init?.body)),
          headers: new Headers(init?.headers),
        });
        return Response.json({
          access_token: accessToken,
          id_token: idToken,
          refresh_token: "rotated-refresh-token",
        });
      },
    });

    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).resolves.toEqual({
      accessToken,
      accountId: "workspace-one",
      email: "new@example.test",
      expiresAt: 1_800_000_000_000,
      idToken,
      kind: "chatgpt",
      planType: "pro",
      refreshToken: "rotated-refresh-token",
      userId: "user-one",
      version: 1,
    });
    expect(requests).toEqual([
      {
        body: {
          client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
          grant_type: "refresh_token",
          refresh_token: "server-only-refresh-token",
        },
        headers: new Headers({ "content-type": "application/json" }),
      },
    ]);
  });

  it("quarantines an identity change in refreshed authority tokens", async () => {
    const refresher = new ChatGptCredentialRefresher({
      fetch: async () =>
        Response.json({
          access_token: jwt({
            exp: 1_800_000_000,
            "https://api.openai.com/auth": {
              chatgpt_account_id: "workspace-two",
            },
          }),
        }),
    });
    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderCredentialIdentityConflictError);
  });

  it("classifies permanent failures without exposing OAuth bodies", async () => {
    const leakedCandidate = "server-only-refresh-token";
    const refresher = new ChatGptCredentialRefresher({
      fetch: async () =>
        Response.json(
          {
            error: {
              code: "refresh_token_reused",
              message: leakedCandidate,
            },
          },
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
    const refresher = new ChatGptCredentialRefresher({
      fetch: async () => new Response("not-json", { status: 401 }),
    });
    await expect(
      refresher.refresh(credential(), new AbortController().signal),
    ).rejects.toBeInstanceOf(ProviderCredentialRequiresSignInError);
  });
});
