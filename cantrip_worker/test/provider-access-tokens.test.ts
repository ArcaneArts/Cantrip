import { describe, expect, it } from "vitest";

import { ProviderAccessTokenClient } from "../src/provider-access-tokens.js";

const start = Date.UTC(2026, 7, 15, 12);

function lease(now: number, accessToken: string) {
  return {
    accessToken,
    credentialRevision: 2,
    expiresAt: new Date(now + 60 * 60_000).toISOString(),
    issuedAt: new Date(now).toISOString(),
    leaseExpiresAt: new Date(now + 5 * 60_000).toISOString(),
    planType: "pro",
    providerAccountId: "account-one",
    providerId: "provider-one",
    providerIdentity: {
      accountId: "upstream-account",
      kind: "chatgpt" as const,
      userId: "upstream-user",
    },
    providerKind: "chatgpt" as const,
  };
}

describe("worker provider access tokens", () => {
  it("caches leases only in memory and bypasses the cache for forced refresh", async () => {
    let now = start;
    const requests: Array<{ body: unknown; headers: Headers; url: URL }> = [];
    const client = new ProviderAccessTokenClient(
      {
        serverUrl: "https://cantrip.example.test",
        token: `ctwk_${"a".repeat(43)}`,
        workerId: "worker one",
      },
      {
        now: () => now,
        fetch: async (input, init) => {
          const body = JSON.parse(String(init?.body));
          requests.push({
            body,
            headers: new Headers(init?.headers),
            url: new URL(String(input)),
          });
          return Response.json(
            lease(now, body.forceRefresh ? "forced-access" : "leased-access"),
          );
        },
      },
    );

    const first = await client.get("provider-one", "account-one");
    const cached = await client.get("provider-one", "account-one");
    expect(first).toBe(cached);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url.pathname).toBe(
      "/api/internal/workers/providers/provider-one/accounts/account-one/access-lease",
    );
    expect(requests[0]?.url.searchParams.get("workerId")).toBe("worker one");
    expect(requests[0]?.headers.get("authorization")).toBe(
      `Bearer ctwk_${"a".repeat(43)}`,
    );
    expect(requests[0]?.body).toEqual({
      credentialRevision: null,
      forceRefresh: false,
      minimumValiditySeconds: 120,
    });

    const forced = await client.get("provider-one", "account-one", {
      forceRefresh: true,
    });
    expect(forced.accessToken).toBe("forced-access");
    expect(requests).toHaveLength(2);
    expect(requests[1]?.body).toEqual({
      credentialRevision: 2,
      forceRefresh: true,
      minimumValiditySeconds: 120,
    });

    await client.get("provider-one", "account-one", {
      credentialRevision: 1,
      forceRefresh: true,
    });
    expect(requests[2]?.body).toEqual({
      credentialRevision: 1,
      forceRefresh: true,
      minimumValiditySeconds: 120,
    });

    now += 4 * 60_000 + 31_000;
    await client.get("provider-one", "account-one");
    expect(requests).toHaveLength(4);
    client.clear("provider-one", "account-one");
    await client.get("provider-one", "account-one");
    expect(requests).toHaveLength(5);
  });

  it("does not copy an untrusted server error body into worker errors", async () => {
    const client = new ProviderAccessTokenClient(
      {
        serverUrl: "https://cantrip.example.test",
        token: `ctwk_${"b".repeat(43)}`,
        workerId: "worker-one",
      },
      {
        fetch: async () =>
          Response.json(
            { error: "server-only-refresh-token must not escape" },
            { status: 503 },
          ),
      },
    );

    let message = "";
    try {
      await client.get("provider-one", "account-one");
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("HTTP 503");
    expect(message).not.toContain("server-only");
  });

  it("coalesces refreshes only when runtimes used the same revision", async () => {
    const revisions: Array<number | null> = [];
    const client = new ProviderAccessTokenClient(
      {
        serverUrl: "https://cantrip.example.test",
        token: `ctwk_${"c".repeat(43)}`,
        workerId: "worker-one",
      },
      {
        now: () => start,
        fetch: async (_input, init) => {
          const body = JSON.parse(String(init?.body)) as {
            credentialRevision: number | null;
          };
          revisions.push(body.credentialRevision);
          await Promise.resolve();
          return Response.json({
            ...lease(start, `access-${body.credentialRevision}`),
            credentialRevision: (body.credentialRevision ?? 0) + 1,
          });
        },
      },
    );

    await Promise.all([
      client.get("provider-one", "account-one", {
        credentialRevision: 1,
        forceRefresh: true,
      }),
      client.get("provider-one", "account-one", {
        credentialRevision: 1,
        forceRefresh: true,
      }),
      client.get("provider-one", "account-one", {
        credentialRevision: 2,
        forceRefresh: true,
      }),
    ]);
    expect(revisions).toEqual([1, 2]);
  });
});
