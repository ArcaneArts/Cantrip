import { describe, expect, it } from "vitest";

import type { ProviderAccessTokenLease } from "@cantrip/protocol";

import type { ProviderAccessTokenClient } from "../src/provider-access-tokens.js";
import { createServerManagedGrokClient } from "../src/server-managed-grok.js";

function lease(
  accessToken: string,
  credentialRevision: number,
): ProviderAccessTokenLease {
  return {
    accessToken,
    credentialRevision,
    email: "grok@example.test",
    expiresAt: "2030-01-01T00:00:00.000Z",
    issuedAt: "2026-08-15T12:00:00.000Z",
    leaseExpiresAt: "2026-08-15T12:05:00.000Z",
    planType: "SuperGrok",
    providerAccountId: "account-one",
    providerId: "provider-one",
    providerIdentity: { kind: "grok", userId: "user-one" },
    providerKind: "grok",
  };
}

describe("server-managed Grok subscription access", () => {
  it("retries a 401 once with a revision-bound forced server refresh", async () => {
    const leaseRequests: unknown[] = [];
    const accessTokens = {
      async get(providerId: string, accountId: string, options: unknown) {
        expect(providerId).toBe("provider-one");
        expect(accountId).toBe("account-one");
        leaseRequests.push(options);
        return leaseRequests.length === 1
          ? lease("access-one", 4)
          : lease("access-two", 5);
      },
    } as unknown as ProviderAccessTokenClient;
    const upstreamTokens: string[] = [];
    const client = createServerManagedGrokClient(
      "provider-one",
      "account-one",
      accessTokens,
      {
        fetch: async (_input, init) => {
          const headers = new Headers(init?.headers);
          upstreamTokens.push(headers.get("authorization") ?? "");
          expect(headers.get("x-userid")).toBe("user-one");
          expect(headers.get("x-email")).toBe("grok@example.test");
          return upstreamTokens.length === 1
            ? new Response(null, { status: 401 })
            : Response.json({ data: [{ id: "grok-code-fast-1" }] });
        },
      },
    );
    try {
      await expect(client.listModels()).resolves.toMatchObject({
        models: [{ id: "grok-code-fast-1", isDefault: true }],
      });
      expect(upstreamTokens).toEqual([
        "Bearer access-one",
        "Bearer access-two",
      ]);
      expect(leaseRequests).toEqual([
        { credentialRevision: undefined, forceRefresh: undefined },
        { credentialRevision: 4, forceRefresh: true },
      ]);
    } finally {
      client.close();
    }
  });

  it("rejects a lease for another provider identity before forwarding it", async () => {
    const accessTokens = {
      async get() {
        return {
          ...lease("access-one", 1),
          providerIdentity: { kind: "chatgpt", accountId: "x", userId: null },
          providerKind: "chatgpt",
        };
      },
    } as unknown as ProviderAccessTokenClient;
    const client = createServerManagedGrokClient(
      "provider-one",
      "account-one",
      accessTokens,
      { fetch: async () => Response.json({ data: [] }) },
    );
    await expect(client.listModels()).rejects.toThrow(
      "mismatched Grok access lease",
    );
    client.close();
  });
});
