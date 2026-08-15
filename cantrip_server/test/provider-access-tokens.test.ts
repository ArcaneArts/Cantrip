import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  ProviderAccessTokenError,
  ProviderAccessTokenService,
  ProviderCredentialRequiresSignInError,
  type ProviderCredentialRefresher,
} from "../src/models/provider-access-tokens.js";
import type { ChatGptProviderCredential } from "../src/models/provider-credentials.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const now = Date.UTC(2026, 7, 15, 12);

function credential(
  overrides: Partial<ChatGptProviderCredential> = {},
): ChatGptProviderCredential {
  return {
    accessToken: "old-access-token",
    accountId: "upstream-account-one",
    email: "person@example.test",
    expiresAt: now + 60_000,
    idToken: "server-only-id-token",
    kind: "chatgpt",
    planType: "pro",
    refreshToken: "server-only-refresh-token",
    userId: "upstream-user-one",
    version: 1,
    ...overrides,
  };
}

async function fixture() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 11) }],
    }),
  );
  await repository.ensureLocalIdentity();
  const provider = await repository.createModelProvider(LOCAL_USER_ID, {
    baseUrl: "https://chatgpt.com/backend-api/codex",
    kind: "chatgpt",
    name: "ChatGPT",
  });
  const accountId = provider.accounts[0]!.id;
  await repository.storeModelProviderAccountCredential(
    LOCAL_USER_ID,
    provider.id,
    accountId,
    credential(),
    0,
  );
  return { accountId, client, providerId: provider.id, repository };
}

describe("provider access token leases", () => {
  it("serializes refresh across server instances and only leases access metadata", async () => {
    const { accountId, client, providerId, repository } = await fixture();
    let refreshes = 0;
    const refresher: ProviderCredentialRefresher = {
      async refresh(input) {
        refreshes += 1;
        await new Promise((resolve) => setTimeout(resolve, 20));
        return {
          ...input,
          accessToken: "rotated-access-token",
          expiresAt: now + 60 * 60_000,
          refreshToken: "rotated-server-only-refresh-token",
        };
      },
    };
    const options = {
      accessLeaseDurationMs: 5 * 60_000,
      now: () => now,
      refreshers: { chatgpt: refresher },
    };
    const firstServer = new ProviderAccessTokenService(repository, options);
    const secondServer = new ProviderAccessTokenService(repository, options);
    try {
      const leases = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          (index % 2 ? firstServer : secondServer).issue({
            accountId,
            forceRefresh: false,
            minimumValidityMs: 2 * 60_000,
            ownerId: LOCAL_USER_ID,
            providerId,
          }),
        ),
      );
      expect(refreshes).toBe(1);
      expect(leases).toHaveLength(12);
      for (const lease of leases) {
        expect(lease).toMatchObject({
          accessToken: "rotated-access-token",
          credentialRevision: 2,
          issuedAt: new Date(now).toISOString(),
          leaseExpiresAt: new Date(now + 5 * 60_000).toISOString(),
          planType: "pro",
          providerAccountId: accountId,
          providerId,
          providerIdentity: {
            accountId: "upstream-account-one",
            kind: "chatgpt",
            userId: "upstream-user-one",
          },
          providerKind: "chatgpt",
        });
        expect(JSON.stringify(lease)).not.toContain("refresh-token");
        expect(JSON.stringify(lease)).not.toContain("id-token");
      }
      const stale = await secondServer.issue({
        accountId,
        credentialRevision: 1,
        forceRefresh: true,
        minimumValidityMs: 2 * 60_000,
        ownerId: LOCAL_USER_ID,
        providerId,
      });
      expect(refreshes).toBe(1);
      expect(stale).toMatchObject({
        accessToken: "rotated-access-token",
        credentialRevision: 2,
      });
      const forced = await firstServer.issue({
        accountId,
        credentialRevision: 2,
        forceRefresh: true,
        minimumValidityMs: 2 * 60_000,
        ownerId: LOCAL_USER_ID,
        providerId,
      });
      expect(refreshes).toBe(2);
      expect(forced).toMatchObject({
        accessToken: "rotated-access-token",
        credentialRevision: 3,
      });
      const raw = await client.query<{
        credential_last_refresh_error: string | null;
        credential_refresh_lease_expires_at: Date | null;
        credential_refresh_lease_id: string | null;
        credential_revision: number;
      }>(`
        SELECT credential_last_refresh_error,
               credential_refresh_lease_expires_at,
               credential_refresh_lease_id,
               credential_revision
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(raw.rows[0]).toMatchObject({
        credential_last_refresh_error: null,
        credential_refresh_lease_expires_at: null,
        credential_refresh_lease_id: null,
        credential_revision: 3,
      });
    } finally {
      await client.close();
    }
  });

  it("records only a safe error and requires sign-in after an invalid grant", async () => {
    const { accountId, client, providerId, repository } = await fixture();
    const service = new ProviderAccessTokenService(repository, {
      now: () => now,
      refreshers: {
        chatgpt: {
          async refresh() {
            throw new ProviderCredentialRequiresSignInError();
          },
        },
      },
    });
    try {
      await expect(
        service.issue({
          accountId,
          forceRefresh: false,
          minimumValidityMs: 2 * 60_000,
          ownerId: LOCAL_USER_ID,
          providerId,
        }),
      ).rejects.toMatchObject<Partial<ProviderAccessTokenError>>({
        code: "reauth-required",
      });
      const raw = await client.query<{
        credential_last_refresh_error: string | null;
        credential_refresh_lease_id: string | null;
        credential_state: string;
      }>(`
        SELECT credential_last_refresh_error, credential_refresh_lease_id,
               credential_state
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(raw.rows[0]).toEqual({
        credential_last_refresh_error: "Provider credential requires sign-in.",
        credential_refresh_lease_id: null,
        credential_state: "reauth-required",
      });
      expect(JSON.stringify(raw.rows[0])).not.toContain("server-only");
    } finally {
      await client.close();
    }
  });

  it("rejects a refreshed identity change and quarantines the account", async () => {
    const { accountId, client, providerId, repository } = await fixture();
    const service = new ProviderAccessTokenService(repository, {
      now: () => now,
      refreshers: {
        chatgpt: {
          async refresh(input) {
            return {
              ...input,
              accountId: "different-upstream-account",
              accessToken: "different-access-token",
              expiresAt: now + 60 * 60_000,
            };
          },
        },
      },
    });
    try {
      await expect(
        service.issue({
          accountId,
          forceRefresh: false,
          minimumValidityMs: 2 * 60_000,
          ownerId: LOCAL_USER_ID,
          providerId,
        }),
      ).rejects.toMatchObject<Partial<ProviderAccessTokenError>>({
        code: "identity-conflict",
      });
      const raw = await client.query<{
        credential_last_refresh_error: string;
        credential_state: string;
      }>(`
        SELECT credential_last_refresh_error, credential_state
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(raw.rows[0]).toEqual({
        credential_last_refresh_error:
          "Provider credential identity changed during refresh.",
        credential_state: "conflict",
      });
      expect(
        (
          await repository.getModelProviderAccountCredential(
            LOCAL_USER_ID,
            providerId,
            accountId,
          )
        )?.credential.accountId,
      ).toBe("upstream-account-one");
    } finally {
      await client.close();
    }
  });

  it("never persists arbitrary refresh error text", async () => {
    const { accountId, client, providerId, repository } = await fixture();
    const leakedCandidate = "server-only-refresh-token";
    const service = new ProviderAccessTokenService(repository, {
      now: () => now,
      refreshers: {
        chatgpt: {
          async refresh() {
            throw new Error(`provider response included ${leakedCandidate}`);
          },
        },
      },
    });
    try {
      await expect(
        service.issue({
          accountId,
          forceRefresh: false,
          minimumValidityMs: 2 * 60_000,
          ownerId: LOCAL_USER_ID,
          providerId,
        }),
      ).rejects.toMatchObject<Partial<ProviderAccessTokenError>>({
        code: "refresh-failed",
      });
      const raw = await client.query<{
        credential_last_refresh_error: string;
      }>(`
        SELECT credential_last_refresh_error
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(raw.rows[0]?.credential_last_refresh_error).toBe(
        "Provider credential refresh failed.",
      );
      expect(JSON.stringify(raw.rows[0])).not.toContain(leakedCandidate);
    } finally {
      await client.close();
    }
  });
});
