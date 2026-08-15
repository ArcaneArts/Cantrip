import { fileURLToPath } from "node:url";

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
import {
  parseProviderCredential,
  redactProviderCredential,
  type ChatGptProviderCredential,
} from "../src/models/provider-credentials.js";
import {
  modelProviderAccountSecretContext,
  SecretVault,
} from "../src/security/secret-vault.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));
const key = (fill: number) => Buffer.alloc(32, fill);

function credential(
  overrides: Partial<ChatGptProviderCredential> = {},
): ChatGptProviderCredential {
  return {
    accessToken: "access-never-log-or-store-plainly",
    accountId: "account-one",
    email: "person@example.test",
    expiresAt: Date.UTC(2026, 7, 20),
    idToken: "identity-never-log-or-store-plainly",
    kind: "chatgpt",
    planType: "pro",
    refreshToken: "refresh-never-log-or-store-plainly",
    userId: "user-one",
    version: 1,
    ...overrides,
  };
}

describe("provider account credential persistence", () => {
  it("encrypts, scopes, rotates, revises, and clears account credentials", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      const oldVault = new SecretVault({
        activeKeyId: "old",
        keys: [{ id: "old", key: key(6) }],
      });
      const repository = new ServerRepository(database, oldVault);
      await repository.ensureLocalIdentity();
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        baseUrl: "https://chatgpt.com/backend-api/codex",
        kind: "chatgpt",
        name: "ChatGPT",
      });
      const accountId = provider.accounts[0]!.id;
      const secret = credential();

      const stored = await repository.storeModelProviderAccountCredential(
        LOCAL_USER_ID,
        provider.id,
        accountId,
        secret,
        0,
      );
      expect(stored).toMatchObject({
        accountId,
        revision: 1,
        state: "signed-in",
        metadata: {
          hasRefreshToken: true,
          kind: "chatgpt",
          subject: "chatgpt:account-one",
        },
      });
      expect(
        await repository.getModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
        ),
      ).toMatchObject({ credential: secret, revision: 1 });
      expect(
        await repository.getModelProviderAccountCredential(
          "different-owner",
          provider.id,
          accountId,
        ),
      ).toBeNull();

      let raw = await client.query<{
        credential_envelope: string;
        credential_revision: number;
        credential_state: string;
        credential_subject: string;
      }>(`
        SELECT credential_envelope, credential_revision, credential_state,
               credential_subject
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      const envelope = raw.rows[0]!.credential_envelope;
      expect(envelope).not.toContain(secret.accessToken);
      expect(envelope).not.toContain(secret.refreshToken!);
      expect(envelope).not.toContain(secret.idToken!);
      expect(raw.rows[0]).toMatchObject({
        credential_revision: 1,
        credential_state: "signed-in",
        credential_subject: "chatgpt:account-one",
      });
      expect(
        oldVault.decrypt(
          envelope,
          modelProviderAccountSecretContext(
            LOCAL_USER_ID,
            provider.id,
            accountId,
            "chatgpt",
          ),
        ),
      ).toContain(secret.accessToken);
      expect(() =>
        oldVault.decrypt(
          envelope,
          modelProviderAccountSecretContext(
            LOCAL_USER_ID,
            provider.id,
            "different-account",
            "chatgpt",
          ),
        ),
      ).toThrow();
      expect(JSON.stringify(provider)).not.toContain(secret.accessToken);
      expect(JSON.stringify(provider)).not.toContain("credentialEnvelope");

      await expect(
        repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
          credential({ accountId: "account-two" }),
          1,
        ),
      ).rejects.toBeInstanceOf(ProviderCredentialIdentityConflictError);
      await expect(
        repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
          credential({ accessToken: "replacement" }),
          0,
        ),
      ).rejects.toBeInstanceOf(ProviderCredentialRevisionConflictError);

      const rotatingRepository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "new",
          keys: [
            { id: "new", key: key(7) },
            { id: "old", key: key(6) },
          ],
        }),
      );
      await rotatingRepository.migrateProviderAccountCredentialSecrets();
      raw = await client.query(`
        SELECT credential_envelope, credential_revision, credential_state,
               credential_subject
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(JSON.parse(raw.rows[0]!.credential_envelope)).toMatchObject({
        keyId: "new",
        version: 1,
      });
      expect(raw.rows[0]!.credential_revision).toBe(1);
      expect(
        await rotatingRepository.clearModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
          1,
        ),
      ).toBe(true);
      expect(
        await rotatingRepository.getModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          accountId,
        ),
      ).toBeNull();
      const cleared = await client.query<{
        credential_envelope: string | null;
        credential_revision: number;
        credential_state: string;
        credential_subject: string | null;
      }>(`
        SELECT credential_envelope, credential_revision, credential_state,
               credential_subject
        FROM model_provider_accounts
        WHERE id = '${accountId}'
      `);
      expect(cleared.rows[0]).toMatchObject({
        credential_envelope: null,
        credential_revision: 2,
        credential_state: "signed-out",
        credential_subject: null,
      });
    } finally {
      await client.close();
    }
  });

  it("redacts tokens and rejects malformed credentials without echoing them", () => {
    const secret = credential();
    const redacted = redactProviderCredential(secret);
    expect(redacted).toEqual({
      email: "person@example.test",
      expiresAt: Date.UTC(2026, 7, 20),
      hasRefreshToken: true,
      kind: "chatgpt",
      planType: "pro",
      subject: "chatgpt:account-one",
      version: 1,
    });
    expect(JSON.stringify(redacted)).not.toContain(secret.accessToken);
    expect(JSON.stringify(redacted)).not.toContain(secret.refreshToken!);
    expect(JSON.stringify(redacted)).not.toContain(secret.idToken!);

    const leakedCandidate = "a-secret-that-must-not-appear";
    expect(() =>
      parseProviderCredential({
        ...secret,
        accessToken: leakedCandidate,
        version: 2,
      }),
    ).toThrowError(/version/u);
    try {
      parseProviderCredential({
        ...secret,
        accessToken: leakedCandidate,
        version: 2,
      });
    } catch (error) {
      expect(String(error)).not.toContain(leakedCandidate);
    }
  });
});
