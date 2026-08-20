import { randomBytes } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import { ProviderAccessTokenClient } from "../src/provider-access-tokens.js";
import { protectProviderCredential } from "../src/protected-secrets.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const now = Date.UTC(2026, 7, 15, 12);
const ownerId = "owner-provider-access";
const providerKey = randomBytes(32);

function encryptionService(): WorkerEncryptionService {
  return {
    componentKey() {
      return { key: new Uint8Array(providerKey), keyRevision: 1 };
    },
    ownerId: () => ownerId,
  } as WorkerEncryptionService;
}

async function wireCredential() {
  const protectedCredential = await protectProviderCredential({
    accountId: "account-one",
    credential: {
      accessToken: "worker-only-access-token",
      accountId: "upstream-account",
      email: "person@example.test",
      expiresAt: now + 60 * 60_000,
      idToken: null,
      kind: "chatgpt",
      planType: "pro",
      refreshToken: "worker-only-refresh-token",
      userId: "upstream-user",
      version: 1,
    },
    service: encryptionService(),
  });
  return {
    accountId: "account-one",
    credential: protectedCredential.credential,
    credentialRevision: 2,
    providerId: "provider-one",
    providerKind: "chatgpt" as const,
  };
}

describe("worker provider access tokens", () => {
  it("opens an opaque worker credential and caches only its short-lived lease", async () => {
    const requests: Array<{ method: string | undefined; url: URL }> = [];
    const record = await wireCredential();
    const client = new ProviderAccessTokenClient(
      {
        serverUrl: "https://cantrip.example.test",
        token: `ctwk_${"a".repeat(43)}`,
        workerId: "worker one",
      },
      encryptionService(),
      {
        now: () => now,
        fetch: async (input, init) => {
          requests.push({ method: init?.method, url: new URL(String(input)) });
          return Response.json(record);
        },
      },
    );

    const first = await client.get("provider-one", "account-one");
    const cached = await client.get("provider-one", "account-one");
    expect(first).toBe(cached);
    expect(first).toMatchObject({
      accessToken: "worker-only-access-token",
      credentialRevision: 2,
      providerKind: "chatgpt",
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.url.pathname).toBe(
      "/api/internal/workers/providers/provider-one/accounts/account-one/credential",
    );
    expect(requests[0]?.url.searchParams.get("workerId")).toBe("worker one");
  });

  it("does not copy an untrusted server error body into worker errors", async () => {
    const client = new ProviderAccessTokenClient(
      {
        serverUrl: "https://cantrip.example.test",
        token: `ctwk_${"b".repeat(43)}`,
        workerId: "worker-one",
      },
      encryptionService(),
      {
        fetch: async () =>
          Response.json(
            { error: "server-only-secret must not escape" },
            { status: 503 },
          ),
      },
    );

    await expect(client.get("provider-one", "account-one")).rejects.toThrow(
      "HTTP 503",
    );
    try {
      await client.get("provider-one", "account-one");
    } catch (error) {
      expect(String(error)).not.toContain("server-only");
    }
  });
});
