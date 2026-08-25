import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("Chat resource audience migration", () => {
  it("defaults existing MCP servers and Policies to IDE and creates Skill metadata", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const audienceIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes('CREATE TABLE "skill_audiences"'),
        ),
      );
      expect(audienceIndex).toBeGreaterThan(0);
      for (const migration of migrations.slice(0, audienceIndex)) {
        for (const statement of migration.sql) await client.exec(statement);
      }
      const opaque = JSON.stringify({
        formatVersion: 1,
        keyRevision: 1,
        envelope: {
          version: 1,
          algorithm: "AES-256-GCM",
          keyRevision: 1,
          nonce: "AAAAAAAAAAAAAAAA",
          ciphertext: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      });
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('audience-owner', 'anonymous', 'Owner');
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'audience-worker', 'audience-owner', 'Worker', 'linux', 'x64', now(), now()
        );
        INSERT INTO model_providers (
          id, owner_id, name, kind, base_url
        ) VALUES (
          'audience-provider', 'audience-owner', 'Provider', 'openai-compatible', 'https://example.test/v1'
        );
        INSERT INTO mcp_servers (
          id, owner_id, name_blind_index, protected_configuration, enabled
        ) VALUES (
          '00000000-0000-4000-8000-000000000169', 'audience-owner',
          '${"M".repeat(43)}', '${opaque}'::jsonb, true
        );
        INSERT INTO policies (
          id, owner_id, key_blind_index, protected_summary, protected_body,
          enabled, mandatory, position
        ) VALUES (
          '00000000-0000-4000-8000-000000000170', 'audience-owner',
          '${"P".repeat(43)}', '${opaque}'::jsonb, '${opaque}'::jsonb,
          true, false, 0
        );
      `);

      for (const statement of migrations[audienceIndex]!.sql) {
        await client.exec(statement);
      }

      const mcp = await client.query<{ audience: string }>(
        "SELECT audience FROM mcp_servers",
      );
      const policies = await client.query<{ audience: string }>(
        "SELECT audience FROM policies",
      );
      expect(mcp.rows).toEqual([{ audience: "ide" }]);
      expect(policies.rows).toEqual([{ audience: "ide" }]);

      await client.exec(`
        INSERT INTO skill_audiences (
          owner_id, worker_id, provider_id, audience_key, audience
        ) VALUES (
          'audience-owner', 'audience-worker', 'audience-provider',
          '${"S".repeat(43)}', 'chat'
        )
      `);
      await expect(
        client.exec(`UPDATE skill_audiences SET audience = 'invalid'`),
      ).rejects.toThrow();
    } finally {
      await client.close();
    }
  }, 30_000);
});
