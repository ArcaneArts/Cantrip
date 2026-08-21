import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";

const migrationsDirectory = fileURLToPath(
  new URL("../drizzle", import.meta.url),
);

async function migrationFiles() {
  return (await readdir(migrationsDirectory))
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort();
}

describe("workflow catalog encryption migration", () => {
  it("removes legacy workflow rows and installs only opaque catalog columns", async () => {
    const database = new PGlite();
    try {
      const files = await migrationFiles();
      for (const migrationFile of files.filter((name) => name < "0126_")) {
        await database.exec(
          await readFile(`${migrationsDirectory}/${migrationFile}`, "utf8"),
        );
      }
      await database.exec(`
        INSERT INTO users (id, kind, display_name)
        VALUES ('workflow-owner', 'anonymous', 'Workflow Owner');

        INSERT INTO workflow_definitions (
          id, owner_id, scope, slug, name, source, trust_state
        ) VALUES (
          'legacy-workflow', 'workflow-owner', 'personal', 'legacy-workflow',
          'LEGACY_WORKFLOW_SENTINEL', 'manual', 'untrusted'
        );

        INSERT INTO workflow_revisions (
          id, workflow_id, revision, definition, source, content_hash,
          created_by_user_id, trust_state
        ) VALUES (
          'legacy-revision', 'legacy-workflow', 1,
          '{"version":1,"sentinel":"LEGACY_WORKFLOW_SENTINEL"}'::jsonb,
          'manual', 'sha256:legacy', 'workflow-owner', 'untrusted'
        );
      `);

      const migration = files.find((name) => name.startsWith("0126_"));
      expect(migration).toBeDefined();
      await database.exec(
        await readFile(`${migrationsDirectory}/${migration!}`, "utf8"),
      );

      const rows = await database.query<{
        definitions: number;
        revisions: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM workflow_definitions) AS definitions,
          (SELECT count(*)::int FROM workflow_revisions) AS revisions
      `);
      expect(rows.rows).toEqual([{ definitions: 0, revisions: 0 }]);

      const workflowColumns = await database.query<{
        column_name: string;
        table_name: string;
      }>(`
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_name IN ('workflow_definitions', 'workflow_revisions')
        ORDER BY table_name, column_name
      `);
      const columns = workflowColumns.rows.map(
        ({ table_name, column_name }) => `${table_name}.${column_name}`,
      );
      expect(columns).toEqual(
        expect.arrayContaining([
          "workflow_definitions.slug_blind_index",
          "workflow_definitions.protected_slug",
          "workflow_definitions.protected_name",
          "workflow_definitions.protected_description",
          "workflow_definitions.protected_provenance",
          "workflow_revisions.content_blind_index",
          "workflow_revisions.protected_content_hash",
          "workflow_revisions.protected_provenance",
        ]),
      );
      expect(columns).not.toEqual(
        expect.arrayContaining([
          "workflow_definitions.slug",
          "workflow_definitions.name",
          "workflow_definitions.description",
          "workflow_definitions.provenance",
          "workflow_revisions.definition",
          "workflow_revisions.content_hash",
          "workflow_revisions.provenance",
        ]),
      );
    } finally {
      await database.close();
    }
  });
});
