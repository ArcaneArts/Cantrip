import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import {
  PolicyConflictError,
  PolicyScopeNotFoundError,
} from "../src/db/policies.js";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";

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
  await repository.policies.ensureBootstrap(LOCAL_USER_ID);
  return { client, repository };
}

describe("policy persistence", () => {
  it("bootstraps one editable default exactly once and keeps its template", async () => {
    const { client, repository } = await fixture();
    try {
      const initial = await repository.policies.list(LOCAL_USER_ID);
      expect(initial.policies).toEqual([
        expect.objectContaining({
          key: "manual-change-protocol",
          name: "Manual Change Protocol",
          enabled: true,
          mandatory: true,
          position: 0,
          rowVersion: 1,
          templateKey: "manual-change-protocol",
        }),
      ]);
      expect(await repository.policies.ensureBootstrap(LOCAL_USER_ID)).toBe(
        false,
      );

      const defaultPolicy = initial.policies[0]!;
      expect(
        await repository.policies.delete(
          LOCAL_USER_ID,
          defaultPolicy.id,
          defaultPolicy.rowVersion,
        ),
      ).toBe(true);
      expect((await repository.policies.list(LOCAL_USER_ID)).policies).toEqual(
        [],
      );
      expect(await repository.policies.ensureBootstrap(LOCAL_USER_ID)).toBe(
        false,
      );

      const restored = await repository.policies.createFromTemplate(
        LOCAL_USER_ID,
        "manual-change-protocol",
      );
      expect(restored).toMatchObject({
        key: "manual-change-protocol",
        mandatory: true,
        templateKey: "manual-change-protocol",
      });
      expect(repository.policies.listTemplates()).toHaveLength(1);
      expect(
        repository.policies.getTemplate("manual-change-protocol")?.bodyMarkdown,
      ).toContain("independently reviewable and mergeable");
    } finally {
      await client.close();
    }
  });

  it("bootstraps existing owners transactionally without reseeding", async () => {
    const { client, repository } = await fixture();
    try {
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('existing-owner', 'anonymous', 'Existing Owner');
      `);
      const attempts = await Promise.all(
        Array.from({ length: 8 }, () =>
          repository.policies.ensureBootstrap("existing-owner"),
        ),
      );
      expect(attempts.filter(Boolean)).toHaveLength(1);
      expect(
        (await repository.policies.list("existing-owner")).policies,
      ).toEqual([expect.objectContaining({ key: "manual-change-protocol" })]);
      expect(await repository.policies.ensureAllOwnersBootstrapped()).toBe(0);

      const raw = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count
        FROM policies
        WHERE owner_id = 'existing-owner'
          AND key = 'manual-change-protocol'
      `);
      expect(raw.rows[0]?.count).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("bootstraps newly created accounts", async () => {
    const { client, repository } = await fixture();
    try {
      const account = await repository.createAccount({
        displayName: "Account Owner",
        email: "owner@example.test",
        normalizedEmail: "owner@example.test",
        passwordHash: "test-password-hash",
        role: "owner",
      });
      expect((await repository.policies.list(account.id)).policies).toEqual([
        expect.objectContaining({
          key: "manual-change-protocol",
          enabled: true,
          mandatory: true,
        }),
      ]);
    } finally {
      await client.close();
    }
  });

  it("uses optimistic edit and collection versions", async () => {
    const { client, repository } = await fixture();
    try {
      const first = await repository.policies.create(LOCAL_USER_ID, {
        key: "review-before-merge",
        name: "Review before merge",
        summary: "Review every change before merging it.",
        bodyMarkdown: "# Review\n\nInspect the final diff.",
        enabled: true,
        mandatory: false,
      });
      const updated = await repository.policies.update(
        LOCAL_USER_ID,
        first.id,
        { rowVersion: first.rowVersion, mandatory: true },
      );
      expect(updated).toMatchObject({ rowVersion: 2, mandatory: true });
      await expect(
        repository.policies.update(LOCAL_USER_ID, first.id, {
          rowVersion: first.rowVersion,
          name: "Stale edit",
        }),
      ).rejects.toMatchObject<Partial<PolicyConflictError>>({
        code: "stale-version",
      });

      const beforeOrder = await repository.policies.list(LOCAL_USER_ID);
      const reversed = await repository.policies.reorder(LOCAL_USER_ID, {
        collectionVersion: beforeOrder.collectionVersion,
        policyIds: beforeOrder.policies.map(({ id }) => id).reverse(),
      });
      expect(reversed.policies.map(({ id }) => id)).toEqual(
        beforeOrder.policies.map(({ id }) => id).reverse(),
      );
      await expect(
        repository.policies.reorder(LOCAL_USER_ID, {
          collectionVersion: beforeOrder.collectionVersion,
          policyIds: beforeOrder.policies.map(({ id }) => id),
        }),
      ).rejects.toMatchObject<Partial<PolicyConflictError>>({
        code: "collection-changed",
      });
    } finally {
      await client.close();
    }
  });

  it("unions mandatory, workspace, and direct policies without duplicates", async () => {
    const { client, repository } = await fixture();
    try {
      const defaultWorkspace =
        await repository.ensureDefaultProjectWorkspace(LOCAL_USER_ID);
      const secondWorkspace = await repository.createProjectWorkspace(
        LOCAL_USER_ID,
        { name: "Company" },
      );
      const project = await repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "not-needed-for-persistence",
        repositoryId: "policy-project",
        nameWithOwner: "ArcaneArts/PolicyProject",
        url: "https://github.com/ArcaneArts/PolicyProject",
        workspaceIds: [defaultWorkspace.id, secondWorkspace.id],
      });
      const scoped = await repository.policies.create(LOCAL_USER_ID, {
        key: "scoped-review",
        name: "Scoped review",
        summary: "Apply review rules to selected projects.",
        bodyMarkdown: "# Scoped review\n\nReview selected projects.",
        enabled: true,
        mandatory: false,
      });
      const disabled = await repository.policies.create(LOCAL_USER_ID, {
        key: "disabled-policy",
        name: "Disabled policy",
        summary: "This policy must remain inactive.",
        bodyMarkdown: "# Disabled\n\nDo not apply this policy.",
        enabled: false,
        mandatory: true,
      });

      let collection = await repository.policies.list(LOCAL_USER_ID);
      const afterWorkspace =
        await repository.policies.replaceWorkspaceAssignments(
          LOCAL_USER_ID,
          secondWorkspace.id,
          {
            collectionVersion: collection.collectionVersion,
            policyIds: [scoped.id],
          },
        );
      collection = await repository.policies.list(LOCAL_USER_ID);
      expect(collection.collectionVersion).toBe(afterWorkspace);
      await repository.policies.replaceProjectAssignments(
        LOCAL_USER_ID,
        project.id,
        {
          collectionVersion: collection.collectionVersion,
          policyIds: [scoped.id, disabled.id],
        },
      );

      expect(
        await repository.policies.listWorkspaceAssignments(
          LOCAL_USER_ID,
          secondWorkspace.id,
        ),
      ).toMatchObject({ directPolicyIds: [scoped.id] });
      expect(
        await repository.policies.listProjectAssignments(
          LOCAL_USER_ID,
          project.id,
        ),
      ).toMatchObject({ directPolicyIds: [scoped.id, disabled.id] });

      const effective = await repository.policies.resolveEffective(
        LOCAL_USER_ID,
        project.id,
      );
      expect(effective?.policies.map(({ key }) => key)).toEqual([
        "manual-change-protocol",
        "scoped-review",
      ]);
      expect(
        effective?.policies.find(({ key }) => key === "scoped-review")?.sources,
      ).toEqual([
        {
          type: "workspace",
          workspaceId: secondWorkspace.id,
          workspaceName: "Company",
        },
        { type: "project", projectId: project.id },
      ]);
      expect(
        effective?.policies.find(({ key }) => key === "manual-change-protocol")
          ?.sources,
      ).toEqual([{ type: "mandatory" }]);
    } finally {
      await client.close();
    }
  });

  it("enforces owner isolation for reads, scopes, and assignments", async () => {
    const { client, repository } = await fixture();
    try {
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('other-owner', 'anonymous', 'Other Owner');
      `);
      await repository.policies.ensureBootstrap("other-owner");
      const localPolicy = (await repository.policies.list(LOCAL_USER_ID))
        .policies[0]!;
      expect(
        await repository.policies.get("other-owner", localPolicy.id),
      ).toBeNull();

      const project = await repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "not-needed-for-persistence",
        repositoryId: "private-policy-project",
        nameWithOwner: "ArcaneArts/PrivatePolicyProject",
        url: "https://github.com/ArcaneArts/PrivatePolicyProject",
      });
      expect(
        await repository.policies.resolveEffective("other-owner", project.id),
      ).toBeNull();
      expect(
        await repository.policies.listProjectAssignments(
          "other-owner",
          project.id,
        ),
      ).toBeNull();
      const otherCollection = await repository.policies.list("other-owner");
      await expect(
        repository.policies.replaceProjectAssignments(
          "other-owner",
          project.id,
          {
            collectionVersion: otherCollection.collectionVersion,
            policyIds: [otherCollection.policies[0]!.id],
          },
        ),
      ).rejects.toBeInstanceOf(PolicyScopeNotFoundError);
      expect(
        (await repository.policies.list("other-owner")).collectionVersion,
      ).toBe(otherCollection.collectionVersion);
    } finally {
      await client.close();
    }
  });
});
