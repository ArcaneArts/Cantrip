import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { describe, expect, it } from "vitest";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

describe("new agent chat CLI preference migration", () => {
  it("keeps existing accounts on the chat view by default", async () => {
    const client = new PGlite();
    try {
      const migrations = readMigrationFiles({ migrationsFolder });
      const migrationIndex = migrations.findIndex((migration) =>
        migration.sql.some((statement) =>
          statement.includes("start_new_agent_chats_in_codex_cli"),
        ),
      );
      const migration = migrations[migrationIndex];
      expect(migration).toBeDefined();
      for (const earlier of migrations.slice(0, migrationIndex)) {
        for (const statement of earlier.sql) await client.exec(statement);
      }
      await client.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('owner-1', 'anonymous', 'Owner');
        INSERT INTO user_settings (user_id) VALUES ('owner-1');
      `);

      for (const statement of migration!.sql) await client.exec(statement);

      const settings = await client.query<{
        start_new_agent_chats_in_codex_cli: boolean;
      }>(`
        SELECT start_new_agent_chats_in_codex_cli
        FROM user_settings
        WHERE user_id = 'owner-1'
      `);
      expect(settings.rows).toEqual([
        { start_new_agent_chats_in_codex_cli: false },
      ]);
      await client.exec(`
        UPDATE user_settings
        SET start_new_agent_chats_in_codex_cli = true
        WHERE user_id = 'owner-1'
      `);
      const enabled = await client.query<{
        start_new_agent_chats_in_codex_cli: boolean;
      }>(`
        SELECT start_new_agent_chats_in_codex_cli
        FROM user_settings
        WHERE user_id = 'owner-1'
      `);
      expect(enabled.rows).toEqual([
        { start_new_agent_chats_in_codex_cli: true },
      ]);
    } finally {
      await client.close();
    }
  });
});
