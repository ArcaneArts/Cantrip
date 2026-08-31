import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { PolicyConflictError } from "../src/db/policies.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";
import { protectedProjectFields } from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function fixture() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  await repository.ensureLocalIdentity();
  return { client, repository };
}

function defaultBootstrap() {
  return {
    expectedBootstrapVersion: 0,
    policies: [],
  };
}

describe("opaque policy persistence", () => {
  it("accepts encrypted client bootstrap exactly once without semantic access", async () => {
    const { client, repository } = await fixture();
    try {
      const initial = await repository.policies.list(LOCAL_USER_ID);
      expect(initial).toMatchObject({ bootstrapVersion: 0, policies: [] });

      await expect(
        repository.policies.bootstrap(LOCAL_USER_ID, {
          expectedBootstrapVersion: 0,
          policies: [
            opaquePolicyCreate("manual-change-protocol", {
              mandatory: true,
              templateKey: "manual-change-protocol",
            }),
          ],
        }),
      ).rejects.toMatchObject<Partial<PolicyConflictError>>({
        code: "invalid-order",
      });

      const bootstrapped = await repository.policies.bootstrap(
        LOCAL_USER_ID,
        defaultBootstrap(),
      );
      expect(bootstrapped.bootstrapVersion).toBe(2);
      expect(bootstrapped.policies).toHaveLength(0);
      expect(
        bootstrapped.policies.map(({ templateKey }) => templateKey),
      ).toEqual([]);
      expect(JSON.stringify(bootstrapped)).not.toContain(
        "Manual Change Protocol",
      );

      const raced = await repository.policies.bootstrap(
        LOCAL_USER_ID,
        defaultBootstrap(),
      );
      expect(raced.policies).toHaveLength(0);
      const raw = await client.query<{
        key_blind_index: string;
        protected_body: unknown;
        protected_summary: unknown;
      }>(`
        SELECT key_blind_index, protected_summary, protected_body
        FROM policies
        WHERE owner_id = '${LOCAL_USER_ID}'
      `);
      expect(raw.rows).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("preserves optimistic mutations and blind-index uniqueness", async () => {
    const { client, repository } = await fixture();
    try {
      const createdInput = opaquePolicyCreate("review-policy");
      const created = await repository.policies.create(
        LOCAL_USER_ID,
        createdInput,
      );
      const replacement = opaquePolicyCreate("review-policy-updated");
      const updated = await repository.policies.update(
        LOCAL_USER_ID,
        created.id,
        {
          rowVersion: created.rowVersion,
          content: {
            protectedSummary: replacement.content.protectedSummary,
            protectedBody: replacement.content.protectedBody,
          },
          mandatory: true,
        },
      );
      expect(updated).toMatchObject({ rowVersion: 2, mandatory: true });
      await expect(
        repository.policies.update(LOCAL_USER_ID, created.id, {
          rowVersion: created.rowVersion,
          enabled: false,
        }),
      ).rejects.toMatchObject<Partial<PolicyConflictError>>({
        code: "stale-version",
      });
      await expect(
        repository.policies.create(
          LOCAL_USER_ID,
          opaquePolicyCreate("duplicate", {
            id: crypto.randomUUID(),
          }),
        ),
      ).resolves.toBeDefined();
      await expect(
        repository.policies.create(
          LOCAL_USER_ID,
          opaquePolicyCreate("duplicate", {
            id: crypto.randomUUID(),
          }),
        ),
      ).rejects.toMatchObject<Partial<PolicyConflictError>>({
        code: "duplicate-key",
      });

      const beforeOrder = await repository.policies.list(LOCAL_USER_ID);
      const reversedIds = beforeOrder.policies.map(({ id }) => id).reverse();
      const reordered = await repository.policies.reorder(LOCAL_USER_ID, {
        collectionVersion: beforeOrder.collectionVersion,
        policyIds: reversedIds,
      });
      expect(reordered.policies.map(({ id }) => id)).toEqual(reversedIds);
    } finally {
      await client.close();
    }
  });

  it("resolves public assignment sources while returning opaque summaries", async () => {
    const { client, repository } = await fixture();
    try {
      await client.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'policy-worker', '${LOCAL_USER_ID}', 'Policy worker', 'linux', 'x64', now(), now()
        )
      `);
      const project = await repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "policy-worker",
        ...protectedProjectFields(),
        repositoryBlindIndex: Buffer.alloc(32, 23).toString("base64url"),
        repositoryId: "opaque-policy-project",
        nameWithOwner: "ArcaneArts/OpaquePolicyProject",
        url: "https://github.com/ArcaneArts/OpaquePolicyProject",
      });
      const mandatory = await repository.policies.create(
        LOCAL_USER_ID,
        opaquePolicyCreate("mandatory", { mandatory: true }),
      );
      const assigned = await repository.policies.create(
        LOCAL_USER_ID,
        opaquePolicyCreate("assigned"),
      );
      const disabled = await repository.policies.create(
        LOCAL_USER_ID,
        opaquePolicyCreate("disabled", { enabled: false, mandatory: true }),
      );
      const chatMandatory = await repository.policies.create(
        LOCAL_USER_ID,
        opaquePolicyCreate("chat-mandatory", {
          audience: "chat",
          mandatory: true,
        }),
      );
      const list = await repository.policies.list(LOCAL_USER_ID);
      await repository.policies.replaceProjectAssignments(
        LOCAL_USER_ID,
        project.id,
        {
          collectionVersion: list.collectionVersion,
          policyIds: [assigned.id, disabled.id],
        },
      );

      const effective = await repository.policies.resolveEffective(
        LOCAL_USER_ID,
        project.id,
      );
      expect(effective?.policies.map(({ id }) => id)).toEqual([
        mandatory.id,
        assigned.id,
      ]);
      const standalone =
        await repository.policies.resolveStandalone(LOCAL_USER_ID);
      expect(standalone.policies).toEqual([
        expect.objectContaining({
          id: chatMandatory.id,
          protectedBody: expect.any(Object),
          protectedSummary: expect.any(Object),
        }),
      ]);
      expect(
        effective?.policies.find(({ id }) => id === assigned.id)?.sources,
      ).toEqual([{ type: "project", projectId: project.id }]);
      expect(effective?.policies[0]).not.toHaveProperty("key");
      expect(effective?.policies[0]).toHaveProperty("protectedSummary");
    } finally {
      await client.close();
    }
  });
});
