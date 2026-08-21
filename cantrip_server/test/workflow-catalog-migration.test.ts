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

describe("workflow definition encryption migrations", () => {
  it("resets legacy rows before requiring opaque catalog and definition columns", async () => {
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

      await database.exec(`
        INSERT INTO workflow_definitions (
          id, owner_id, scope, slug_blind_index, protected_slug,
          protected_name, protected_description, protected_provenance,
          source, trust_state
        ) VALUES (
          'catalog-workflow', 'workflow-owner', 'personal', 'blind-slug',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          'manual', 'untrusted'
        );

        INSERT INTO workflow_revisions (
          id, workflow_id, revision, source, protected_provenance,
          trust_state, content_blind_index, protected_content_hash,
          created_by_user_id
        ) VALUES (
          'catalog-revision', 'catalog-workflow', 1, 'manual', '{}'::jsonb,
          'untrusted', 'blind-content', '{}'::jsonb, 'workflow-owner'
        );
      `);
      const definitionMigration = files.find((name) =>
        name.startsWith("0127_"),
      );
      expect(definitionMigration).toBeDefined();
      await database.exec(
        await readFile(
          `${migrationsDirectory}/${definitionMigration!}`,
          "utf8",
        ),
      );
      const definitionRows = await database.query<{
        definitions: number;
        protected_definition: string;
        revisions: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM workflow_definitions) AS definitions,
          (SELECT count(*)::int FROM workflow_revisions) AS revisions,
          (SELECT data_type FROM information_schema.columns
           WHERE table_name = 'workflow_revisions'
             AND column_name = 'protected_definition') AS protected_definition
      `);
      expect(definitionRows.rows).toEqual([
        {
          definitions: 0,
          protected_definition: "jsonb",
          revisions: 0,
        },
      ]);

      await database.exec(`
        INSERT INTO workflow_definitions (
          id, owner_id, scope, slug_blind_index, protected_slug,
          protected_name, protected_description, protected_provenance,
          source, trust_state
        ) VALUES (
          'runtime-workflow', 'workflow-owner', 'personal', 'runtime-blind',
          '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, '{}'::jsonb,
          'manual', 'untrusted'
        );
        INSERT INTO workflow_revisions (
          id, workflow_id, revision, source, protected_provenance,
          trust_state, content_blind_index, protected_content_hash,
          protected_definition, created_by_user_id
        ) VALUES (
          'runtime-revision', 'runtime-workflow', 1, 'manual', '{}'::jsonb,
          'untrusted', 'runtime-content', '{}'::jsonb, '{}'::jsonb,
          'workflow-owner'
        );
        INSERT INTO workflow_revision_nodes (
          id, revision_id, node_key, node_type, name, position,
          configuration, input_schema, output_schema,
          permission_requirements, mutation_mode
        ) VALUES (
          'runtime-node', 'runtime-revision', 'node-1', 'agent',
          'Encrypted workflow node', 0, '{}'::jsonb, '{}'::jsonb,
          '{}'::jsonb, '{}'::jsonb, 'read-only'
        );
        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, status,
          idempotency_key, structured_input
        ) VALUES (
          'legacy-run', 'runtime-workflow', 'runtime-revision',
          'workflow-owner', 'queued', 'legacy-run-once',
          '{"sentinel":"LEGACY_RUN_SENTINEL"}'::jsonb
        );
      `);
      const runtimeMigration = files.find((name) => name.startsWith("0128_"));
      expect(runtimeMigration).toBeDefined();
      await database.exec(
        await readFile(`${migrationsDirectory}/${runtimeMigration!}`, "utf8"),
      );
      const runtimeRows = await database.query<{
        protected_input: string;
        runs: number;
      }>(`
        SELECT
          (SELECT count(*)::int FROM workflow_runs) AS runs,
          (SELECT data_type FROM information_schema.columns
           WHERE table_name = 'workflow_runs'
             AND column_name = 'protected_input') AS protected_input
      `);
      expect(runtimeRows.rows).toEqual([{ protected_input: "jsonb", runs: 0 }]);
    } finally {
      await database.close();
    }
  });
});
