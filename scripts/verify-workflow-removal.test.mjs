import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  forbiddenWorkflowReferences,
  removedWorkflowArtifactPaths,
  verifyWorkflowRemoval,
  workflowRemovalMigrationViolations,
} from "./verify-workflow-removal.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("current tree satisfies the durable workflow removal contract", async () => {
  const result = await verifyWorkflowRemoval({ root });
  assert.ok(result.filesScanned > 0);
  assert.equal(result.removedArtifacts, removedWorkflowArtifactPaths.length);
});

test("finds restored product types, routes, commands, tables, and docs", () => {
  const violations = forbiddenWorkflowReferences([
    {
      file: "cantrip_server/src/restored.ts",
      sourceText: [
        'const run: WorkflowRun = await load("workflow_runs");',
        'app.post("/api/workflow-runs", handler);',
        'dispatch({ type: "workflow.node.execute" });',
        "See docs/WORKFLOW_OPERATIONS.md for the durable workflow.",
      ].join("\n"),
    },
  ]);
  assert.equal(violations.length, 6);
  assert.match(violations.join("\n"), /retired workflow type/u);
  assert.match(violations.join("\n"), /retired workflow table/u);
  assert.match(violations.join("\n"), /retired workflow HTTP surface/u);
  assert.match(violations.join("\n"), /retired workflow command/u);
  assert.match(
    violations.join("\n"),
    /retired workflow product documentation/u,
  );
});

test("allows the GitHub Actions workflow_runs response field", () => {
  assert.deepEqual(
    forbiddenWorkflowReferences([
      {
        file: "cantrip_worker/src/github.ts",
        sourceText: "const runs = response.workflow_runs;",
      },
    ]),
    [],
  );
  assert.equal(
    forbiddenWorkflowReferences([
      {
        file: "cantrip_worker/src/github.ts",
        sourceText: "const definitions = response.workflow_definitions;",
      },
    ]).length,
    1,
  );
});

test("requires the forward migration and its journal entry to remain complete", async () => {
  const [migrationSql, journal] = await Promise.all([
    readFile(
      path.join(root, "cantrip_server/drizzle/0191_wakeful_vector.sql"),
      "utf8",
    ),
    readFile(
      path.join(root, "cantrip_server/drizzle/meta/_journal.json"),
      "utf8",
    ).then(JSON.parse),
  ]);
  assert.deepEqual(
    workflowRemovalMigrationViolations({ migrationSql, journal }),
    [],
  );
  assert.ok(
    workflowRemovalMigrationViolations({
      migrationSql: migrationSql.replace(
        'DROP TABLE "workflow_definitions"',
        "",
      ),
      journal: { entries: [] },
    }).length >= 2,
  );
});

test("release and repository checks execute the removal verifier", async () => {
  const [manifest, releaseSource] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "scripts/release.mjs"), "utf8"),
  ]);
  assert.equal(
    manifest.scripts["verify:workflow-removal"],
    "node scripts/verify-workflow-removal.mjs",
  );
  assert.match(
    manifest.scripts["verify:installation-compatibility"],
    /verify:workflow-removal/u,
  );
  assert.match(manifest.scripts.check, /verify:workflow-removal/u);
  assert.match(releaseSource, /scripts\/verify-workflow-removal\.mjs/u);
});
