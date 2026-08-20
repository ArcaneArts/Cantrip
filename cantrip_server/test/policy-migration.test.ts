import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import * as schema from "../src/db/schema.js";

import { opaquePolicyCreate } from "./policy-encryption-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function applyMigrationRange(
  client: PGlite,
  firstIndex: number,
  lastIndex: number,
) {
  const files = (await readdir(migrationsFolder))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()
    .filter((name) => {
      const index = Number.parseInt(name.slice(0, 4), 10);
      return index >= firstIndex && index <= lastIndex;
    });
  for (const file of files) {
    await client.exec(await readFile(`${migrationsFolder}/${file}`, "utf8"));
  }
}

describe("encrypted policy migration", () => {
  it("discards the allowed pre-release plaintext rows and resets bootstrap state", async () => {
    const client = new PGlite();
    try {
      await applyMigrationRange(client, 0, 117);
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');
        INSERT INTO policy_owner_states (
          owner_id, bootstrap_version, collection_version
        ) VALUES ('owner-1', 1, 7);
        INSERT INTO policies (
          id, owner_id, key, name, summary, body_markdown, position
        ) VALUES (
          'policy-1', 'owner-1', 'plaintext-policy', 'Plaintext policy',
          'migration-policy-sentinel', '# migration-policy-body-sentinel', 0
        );
      `);

      await applyMigrationRange(client, 118, 118);

      const policies = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM policies
      `);
      const states = await client.query<{
        bootstrap_version: number;
        collection_version: number;
      }>(`
        SELECT bootstrap_version, collection_version
        FROM policy_owner_states
        WHERE owner_id = 'owner-1'
      `);
      const columns = await client.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'policies'
      `);
      expect(policies.rows[0]?.count).toBe(0);
      expect(states.rows).toEqual([
        { bootstrap_version: 0, collection_version: 8 },
      ]);
      expect(columns.rows.map(({ column_name }) => column_name)).toEqual(
        expect.arrayContaining([
          "key_blind_index",
          "protected_summary",
          "protected_body",
        ]),
      );
      expect(columns.rows.map(({ column_name }) => column_name)).not.toEqual(
        expect.arrayContaining(["key", "name", "summary", "body_markdown"]),
      );
    } finally {
      await client.close();
    }
  });

  it("requires opaque fields and keeps policy rows owner-scoped", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    try {
      await migrate(database, { migrationsFolder });
      await database.insert(schema.users).values({
        id: "owner-1",
        kind: "anonymous",
        displayName: "Owner",
      });
      await database.insert(schema.policyOwnerStates).values({
        ownerId: "owner-1",
        bootstrapVersion: 2,
        collectionVersion: 1,
      });
      const policy = opaquePolicyCreate("migration-policy", {
        id: "00000000-0000-4000-8000-000000000101",
      });
      await database.insert(schema.policies).values({
        id: policy.id,
        ownerId: "owner-1",
        keyBlindIndex: policy.content.keyBlindIndex,
        protectedSummary: policy.content.protectedSummary,
        protectedBody: policy.content.protectedBody,
        enabled: policy.enabled,
        mandatory: policy.mandatory,
        position: 0,
        templateKey: policy.templateKey,
      });

      await expect(
        client.exec(`
          UPDATE policies SET key_blind_index = 'too-short'
          WHERE id = '${policy.id}'
        `),
      ).rejects.toThrow();
      await expect(
        client.exec(`
          UPDATE policies SET row_version = 0 WHERE id = '${policy.id}'
        `),
      ).rejects.toThrow();

      await client.exec(`DELETE FROM users WHERE id = 'owner-1';`);
      const rows = await client.query<{ count: number }>(`
        SELECT count(*)::int AS count FROM policies
      `);
      expect(rows.rows[0]?.count).toBe(0);
    } finally {
      await client.close();
    }
  });
});
