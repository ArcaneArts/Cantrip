import { fileURLToPath } from "node:url";

import type { ProtectedSecretEnvelope } from "@cantrip/protocol/protected-secrets";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  LOCAL_USER_ID,
  ProviderCredentialIdentityConflictError,
  ProviderCredentialRevisionConflictError,
  ServerRepository,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const providerId = "00000000-0000-4000-8000-000000000921";
const mcpId = "00000000-0000-4000-8000-000000000922";

function envelope(ciphertext: string): ProtectedSecretEnvelope {
  return {
    formatVersion: 1,
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: Buffer.from(ciphertext.padEnd(32, "x")).toString("base64url"),
    },
  };
}

describe("opaque provider and MCP persistence", () => {
  it("stores only endpoint-created envelopes and enforces opaque revisions", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "unrelated-server-vault",
          keys: [{ id: "unrelated-server-vault", key: Buffer.alloc(32, 9) }],
        }),
      );
      await repository.ensureLocalIdentity();

      const protectedApiKey = envelope("provider-ciphertext-sentinel");
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        id: providerId,
        baseUrl: "https://chatgpt.com/backend-api/codex",
        kind: "chatgpt",
        name: "ChatGPT",
        protectedApiKey,
      });
      const accountId = provider.accounts[0]!.id;
      const protectedCredential = {
        subjectBlindIndex: "A".repeat(43),
        protectedCredential: envelope("oauth-ciphertext-sentinel"),
      };
      await expect(
        repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          providerId,
          accountId,
          protectedCredential,
          {
            expiresAt: "2026-08-21T00:00:00.000Z",
          },
          0,
        ),
      ).resolves.toMatchObject({
        accountId,
        credential: protectedCredential,
        revision: 1,
        state: "signed-in",
      });
      await expect(
        repository.getModelProviderAccountCredential(
          "another-owner",
          providerId,
          accountId,
        ),
      ).resolves.toBeNull();
      await expect(
        repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          providerId,
          accountId,
          { ...protectedCredential, subjectBlindIndex: "B".repeat(43) },
          { expiresAt: null },
          1,
        ),
      ).rejects.toBeInstanceOf(ProviderCredentialIdentityConflictError);
      await expect(
        repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          providerId,
          accountId,
          protectedCredential,
          { expiresAt: null },
          0,
        ),
      ).rejects.toBeInstanceOf(ProviderCredentialRevisionConflictError);

      const protectedConfiguration = envelope("mcp-ciphertext-sentinel");
      await expect(
        repository.createMcpServer(LOCAL_USER_ID, null, {
          id: mcpId,
          enabled: true,
          nameBlindIndex: "C".repeat(43),
          protectedConfiguration,
        }),
      ).resolves.toMatchObject({
        id: mcpId,
        nameBlindIndex: "C".repeat(43),
        protectedConfiguration,
      });

      const raw = await client.query<{
        email: string | null;
        plan_type: string | null;
        protected_api_key: unknown;
        protected_credential: unknown;
        protected_configuration: unknown;
      }>(`
        SELECT a.email, a.plan_type, p.protected_api_key, a.protected_credential,
               m.protected_configuration
        FROM model_providers p
        JOIN model_provider_accounts a ON a.provider_id = p.id
        JOIN mcp_servers m ON m.owner_id = p.owner_id
        WHERE p.id = '${providerId}' AND m.id = '${mcpId}'
      `);
      expect(raw.rows[0]).toMatchObject({
        email: null,
        plan_type: null,
        protected_api_key: protectedApiKey,
        protected_credential: protectedCredential.protectedCredential,
        protected_configuration: protectedConfiguration,
      });
      expect(JSON.stringify(raw.rows[0])).not.toContain("usable-provider-key");
      expect(JSON.stringify(raw.rows[0])).not.toContain("usable-oauth-token");
      expect(JSON.stringify(raw.rows[0])).not.toContain("usable-mcp-secret");

      const legacyColumns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE
          (table_name = 'model_providers'
            AND column_name IN ('api_key', 'api_key_envelope'))
          OR (table_name = 'model_provider_accounts'
            AND column_name IN ('credential_envelope', 'credential_subject'))
          OR (table_name = 'mcp_servers'
            AND column_name IN (
              'name', 'command', 'url', 'environment',
              'environment_envelope', 'headers', 'headers_envelope',
              'environment_headers', 'bearer_token_environment_variable'
            ))
      `);
      expect(legacyColumns.rows).toEqual([]);
    } finally {
      await client.close();
    }
  }, 20_000);
});
