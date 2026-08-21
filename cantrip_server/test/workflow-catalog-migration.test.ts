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

describe("workflow encryption migrations", () => {
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

      await database.exec(`
        INSERT INTO workflow_runs (
          id, workflow_id, workflow_revision_id, owner_id, status,
          idempotency_key, structured_input, protected_input
        ) VALUES (
          'gate-run', 'runtime-workflow', 'runtime-revision',
          'workflow-owner', 'waiting', 'gate-run-once', '{}'::jsonb,
          '{}'::jsonb
        );
        INSERT INTO workflow_run_nodes (
          id, run_id, revision_node_id, node_key, node_type, status,
          structured_input
        ) VALUES (
          'gate-run-node', 'gate-run', 'runtime-node', 'gate-opaque-id',
          'gate', 'waiting-for-approval', '{}'::jsonb
        );
        INSERT INTO workflow_approval_gates (
          id, run_id, run_node_id, gate_key, prompt,
          permission_manifest, requested_by_type, decision_reason
        ) VALUES (
          'legacy-gate', 'gate-run', 'gate-run-node', 'gate-opaque-id',
          'LEGACY_GATE_PROMPT_SENTINEL',
          '{"skills":["LEGACY_GATE_PERMISSION_SENTINEL"]}'::jsonb,
          'workflow', 'LEGACY_GATE_REASON_SENTINEL'
        );
      `);
      const gateMigration = files.find((name) => name.startsWith("0129_"));
      expect(gateMigration).toBeDefined();
      await database.exec(
        await readFile(`${migrationsDirectory}/${gateMigration!}`, "utf8"),
      );
      const gateColumns = await database.query<{ column_name: string }>(`
        SELECT column_name
        FROM information_schema.columns
        WHERE table_name = 'workflow_approval_gates'
        ORDER BY column_name
      `);
      const gateColumnNames = gateColumns.rows.map(
        ({ column_name }) => column_name,
      );
      expect(gateColumnNames).toEqual(
        expect.arrayContaining([
          "denial_policy",
          "protected_request",
          "protected_response",
        ]),
      );
      expect(gateColumnNames).not.toEqual(
        expect.arrayContaining([
          "prompt",
          "permission_manifest",
          "interaction_request_id",
          "decision_reason",
        ]),
      );
      const gateRows = await database.query<{
        gates: number;
        protected_request: unknown;
      }>(`
        SELECT
          count(*)::int AS gates,
          max(protected_request::text) AS protected_request
        FROM workflow_approval_gates
      `);
      expect(gateRows.rows).toEqual([{ gates: 1, protected_request: null }]);

      await database.exec(`
        UPDATE workflow_runs
        SET pause_reason = 'LEGACY_PAUSE_REASON_SENTINEL',
            cancel_reason = 'LEGACY_CANCEL_REASON_SENTINEL'
        WHERE id = 'gate-run';
        INSERT INTO workflow_run_events (
          run_id, run_node_id, sequence, event_key, type, payload,
          actor_type
        ) VALUES (
          'gate-run', 'gate-run-node', 0, 'legacy-content-event',
          'workflow.node.message',
          '{"message":"LEGACY_EVENT_CONTENT_SENTINEL"}'::jsonb,
          'worker'
        );
      `);
      const eventMigration = files.find((name) => name.startsWith("0130_"));
      expect(eventMigration).toBeDefined();
      await database.exec(
        await readFile(`${migrationsDirectory}/${eventMigration!}`, "utf8"),
      );
      const protectedColumns = await database.query<{
        column_name: string;
      }>(`
        SELECT table_name || '.' || column_name AS column_name
        FROM information_schema.columns
        WHERE (table_name = 'workflow_runs' AND column_name IN (
          'pause_reason', 'cancel_reason',
          'protected_pause_reason', 'protected_cancel_reason'
        )) OR (table_name = 'workflow_run_events' AND column_name IN (
          'payload', 'public_payload', 'protected_payload'
        ))
        ORDER BY column_name
      `);
      expect(
        protectedColumns.rows.map(({ column_name }) => column_name),
      ).toEqual([
        "workflow_run_events.protected_payload",
        "workflow_run_events.public_payload",
        "workflow_runs.protected_cancel_reason",
        "workflow_runs.protected_pause_reason",
      ]);
      const eventRows = await database.query<{
        protected_payload: unknown;
        public_payload: unknown;
      }>(`
        SELECT protected_payload, public_payload
        FROM workflow_run_events
        WHERE event_key = 'legacy-content-event'
      `);
      expect(eventRows.rows).toEqual([
        { protected_payload: null, public_payload: {} },
      ]);

      const triggerMigration = files.find((name) => name.startsWith("0131_"));
      expect(triggerMigration).toBeDefined();
      await database.exec(
        await readFile(`${migrationsDirectory}/${triggerMigration!}`, "utf8"),
      );
      const triggerColumns = await database.query<{ column_name: string }>(`
        SELECT table_name || '.' || column_name AS column_name
        FROM information_schema.columns
        WHERE table_name IN (
          'workflow_automation_triggers', 'workflow_trigger_deliveries'
        )
        ORDER BY column_name
      `);
      const triggerColumnNames = triggerColumns.rows.map(
        ({ column_name }) => column_name,
      );
      expect(triggerColumnNames).toEqual(
        expect.arrayContaining([
          "workflow_automation_triggers.public_configuration",
          "workflow_automation_triggers.protected_configuration",
          "workflow_automation_triggers.protected_input",
          "workflow_automation_triggers.protected_name",
          "workflow_trigger_deliveries.protected_payload",
          "workflow_trigger_deliveries.public_provenance",
        ]),
      );
      expect(triggerColumnNames).not.toEqual(
        expect.arrayContaining([
          "workflow_automation_triggers.name",
          "workflow_automation_triggers.configuration",
          "workflow_automation_triggers.structured_input",
          "workflow_automation_triggers.last_error",
          "workflow_trigger_deliveries.trigger_provenance",
          "workflow_trigger_deliveries.error_message",
        ]),
      );
    } finally {
      await database.close();
    }
  });
});
