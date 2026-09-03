import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

export const removedWorkflowArtifactPaths = [
  "cantrip_app/src/components/workflows",
  "cantrip_app/src/lib/workflow-api.ts",
  "cantrip_app/src/lib/workflow-encryption.test.ts",
  "cantrip_app/src/lib/workflow-encryption.ts",
  "cantrip_app/src/lib/workflow-trigger-encryption.test.ts",
  "cantrip_app/src/lib/workflow-trigger-encryption.ts",
  "cantrip_server/src/app/routes/workflow-definitions.ts",
  "cantrip_server/src/app/routes/workflow-runs.ts",
  "cantrip_server/src/app/routes/workflow-trigger-delivery.ts",
  "cantrip_server/src/app/routes/workflow-trigger-management.ts",
  "cantrip_server/src/app/routes/project-workflow-registry.ts",
  "cantrip_server/src/app/runtime/workflow-scheduling-runtime.ts",
  "cantrip_server/src/db/workflow-run-transitions.ts",
  "cantrip_server/src/db/workflow-runs.ts",
  "cantrip_server/src/db/workflow-triggers.ts",
  "cantrip_server/src/db/workflows.ts",
  "cantrip_server/src/workflows",
  "cantrip_server/test/workflow-catalog-encryption.test.ts",
  "cantrip_server/test/workflow-catalog-migration.test.ts",
  "cantrip_server/test/workflow-definition-api.test.ts",
  "cantrip_server/test/workflow-domain-migration.test.ts",
  "cantrip_server/test/workflow-event-minimization.test.ts",
  "cantrip_server/test/workflow-execution.test.ts",
  "cantrip_server/test/workflow-executor-coordination.test.ts",
  "cantrip_server/test/workflow-generation-api.test.ts",
  "cantrip_server/test/workflow-repository-api.test.ts",
  "cantrip_server/test/workflow-run-api.test.ts",
  "cantrip_server/test/workflow-values.test.ts",
  "cantrip_worker/src/workflow-execution-encryption.ts",
  "cantrip_worker/src/workflow-repository.ts",
  "cantrip_worker/test/workflow-execution-encryption.test.ts",
  "cantrip_worker/test/workflow-repository.test.ts",
  "cantrip_worker/test/workflow-trigger-encryption.test.ts",
  "packages/crypto/src/workflow-content.ts",
  "packages/crypto/test/workflow-content.test.ts",
  "packages/protocol/src/workflow-content.ts",
  "packages/protocol/src/workflows.ts",
  "packages/protocol/test/workflows.test.ts",
  "docs/WORKFLOW_IMPLEMENTATION_AUDIT.md",
  "docs/WORKFLOW_OPERATIONS.md",
  "docs/WORKFLOW_ORCHESTRATION.md",
  "docs/adr/0004-codex-native-workflow-control-plane.md",
];

export const workflowRemovalMigrationPath =
  "cantrip_server/drizzle/0191_wakeful_vector.sql";
export const workflowRemovalMigrationTestPath =
  "cantrip_server/test/workflow-removal-migration.test.ts";

const removedWorkflowTables = [
  "workflow_trigger_deliveries",
  "workflow_approval_gates",
  "workflow_run_events",
  "workflow_worktree_leases",
  "workflow_node_attempts",
  "workflow_run_node_dependencies",
  "workflow_run_node_items",
  "workflow_run_nodes",
  "workflow_automation_triggers",
  "workflow_runs",
  "workflow_revision_edges",
  "workflow_revision_nodes",
  "workflow_revisions",
  "workflow_definitions",
];

const scanTargets = [
  ".github",
  "README.md",
  "cantrip_app/src",
  "cantrip_cli/src",
  "cantrip_server/src",
  "cantrip_server/test",
  "cantrip_site/src",
  "cantrip_worker/src",
  "cantrip_worker/test",
  "deploy",
  "distribution",
  "docs",
  "package.json",
  "packages",
  "scripts",
];

const ignoredDirectoryNames = new Set([
  ".build",
  ".git",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "upstream",
]);

const scannedExtensions = new Set([
  ".cjs",
  ".css",
  ".html",
  ".js",
  ".json",
  ".jsx",
  ".md",
  ".mjs",
  ".rs",
  ".scss",
  ".sql",
  ".toml",
  ".ts",
  ".tsx",
  ".yaml",
  ".yml",
]);

const selfPaths = new Set([
  "scripts/verify-workflow-removal.mjs",
  "scripts/verify-workflow-removal.test.mjs",
]);

const githubActionsSqlFieldPaths = new Set([
  "cantrip_worker/src/github.ts",
  "cantrip_worker/test/github.test.ts",
]);

const forbiddenPatterns = [
  {
    name: "retired workflow type",
    expression:
      /\b(?:Workflow|workflow)(?:Definition|Revision|Run|Node|Edge|Attempt|ApprovalGate|RunEvent|TriggerDelivery|AutomationTrigger|WorktreeLease)s?\b/gu,
  },
  {
    name: "retired workflow table",
    expression:
      /\bworkflow_(?:definitions|revisions|revision_nodes|revision_edges|runs|run_nodes|run_node_dependencies|run_node_items|node_attempts|worktree_leases|run_events|approval_gates|automation_triggers|trigger_deliveries)\b/gu,
    isAllowed: ({ file, value }) =>
      value === "workflow_runs" && githubActionsSqlFieldPaths.has(file),
  },
  {
    name: "retired workflow HTTP surface",
    expression:
      /\/api\/(?:workflows|workflow-runs|workflow-triggers|workflow-hooks)\b|\bworkflow-(?:generation|repository)\b/gu,
  },
  {
    name: "retired workflow module",
    expression:
      /@cantrip\/(?:protocol|crypto)\/(?:workflows|workflow-content)|(?:^|["'`/])components\/workflows\b|\bworkflow-(?:api|encryption|execution|scheduling)\b/gu,
  },
  {
    name: "retired workflow command",
    expression: /\bworkflow\.(?:node|gate|trigger|definition|repository)\b/gu,
  },
  {
    name: "retired workflow live resource",
    expression: /["'`]workflow-run["'`]/gu,
  },
  {
    name: "retired workflow product documentation",
    expression:
      /WORKFLOW_(?:IMPLEMENTATION_AUDIT|OPERATIONS|ORCHESTRATION)\.md|0004-codex-native-workflow-control-plane\.md|\bdurable[- ]workflow\b/giu,
  },
];

function normalizePath(value) {
  return value.split(path.sep).join("/");
}

async function pathExists(target) {
  return lstat(target)
    .then(() => true)
    .catch((error) => {
      if (error?.code === "ENOENT") return false;
      throw error;
    });
}

async function textFilePaths(target) {
  const entry = await lstat(target).catch((error) => {
    if (error?.code === "ENOENT") return null;
    throw error;
  });
  if (!entry) return [];
  if (entry.isSymbolicLink()) return [];
  if (entry.isFile()) {
    return scannedExtensions.has(path.extname(target)) ? [target] : [];
  }
  if (!entry.isDirectory()) return [];
  const entries = await readdir(target, { withFileTypes: true });
  const nested = await Promise.all(
    entries
      .filter(
        (child) =>
          !child.isSymbolicLink() &&
          !(child.isDirectory() && ignoredDirectoryNames.has(child.name)),
      )
      .map((child) => textFilePaths(path.join(target, child.name))),
  );
  return nested.flat();
}

function lineForOffset(sourceText, offset) {
  return sourceText.slice(0, offset).split("\n").length;
}

export function forbiddenWorkflowReferences(files) {
  const violations = [];
  for (const { file, sourceText } of files) {
    if (selfPaths.has(file) || file === workflowRemovalMigrationTestPath) {
      continue;
    }
    for (const pattern of forbiddenPatterns) {
      pattern.expression.lastIndex = 0;
      for (const match of sourceText.matchAll(pattern.expression)) {
        if (pattern.isAllowed?.({ file, value: match[0] })) continue;
        violations.push(
          `${file}:${lineForOffset(sourceText, match.index ?? 0)}: ${pattern.name}: ${match[0]}`,
        );
      }
    }
  }
  return violations;
}

export function workflowRemovalMigrationViolations({ migrationSql, journal }) {
  const violations = [];
  for (const table of removedWorkflowTables) {
    if (!migrationSql.includes(`DROP TABLE "${table}"`)) {
      violations.push(`removal migration no longer drops ${table}`);
    }
  }
  for (const fragment of [
    'DELETE FROM "agent_interaction_requests"',
    'DROP COLUMN "workflow_run_id"',
    'DROP COLUMN "workflow_node_id"',
    'DELETE FROM "project_branch_leases"',
    'DROP COLUMN "workflow_worktree_lease_id"',
    'DELETE FROM "tunnels"',
    'DELETE FROM "account_storage_usage_current"',
    'DELETE FROM "account_storage_usage_snapshots"',
  ]) {
    if (!migrationSql.includes(fragment)) {
      violations.push(`removal migration lost required cleanup: ${fragment}`);
    }
  }
  if (
    !Array.isArray(journal?.entries) ||
    !journal.entries.some(
      (entry) => entry?.idx === 191 && entry?.tag === "0191_wakeful_vector",
    )
  ) {
    violations.push(
      "migration journal no longer registers 0191_wakeful_vector",
    );
  }
  return violations;
}

export async function verifyWorkflowRemoval({ root = scriptRoot } = {}) {
  const violations = [];
  for (const artifact of removedWorkflowArtifactPaths) {
    if (await pathExists(path.join(root, artifact))) {
      violations.push(`${artifact}: retired workflow artifact was restored`);
    }
  }

  if (!(await pathExists(path.join(root, workflowRemovalMigrationTestPath)))) {
    violations.push(
      `${workflowRemovalMigrationTestPath}: destructive migration coverage is missing`,
    );
  }

  const migrationPath = path.join(root, workflowRemovalMigrationPath);
  const journalPath = path.join(
    root,
    "cantrip_server/drizzle/meta/_journal.json",
  );
  const [migrationSql, journalText] = await Promise.all([
    readFile(migrationPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return "";
      throw error;
    }),
    readFile(journalPath, "utf8").catch((error) => {
      if (error?.code === "ENOENT") return '{"entries":[]}';
      throw error;
    }),
  ]);
  let journal;
  try {
    journal = JSON.parse(journalText);
  } catch {
    violations.push(
      `${normalizePath(path.relative(root, journalPath))}: invalid JSON`,
    );
    journal = { entries: [] };
  }
  violations.push(
    ...workflowRemovalMigrationViolations({ migrationSql, journal }).map(
      (violation) => `${workflowRemovalMigrationPath}: ${violation}`,
    ),
  );

  const paths = (
    await Promise.all(
      scanTargets.map((target) => textFilePaths(path.join(root, target))),
    )
  )
    .flat()
    .sort();
  const files = await Promise.all(
    paths.map(async (filePath) => ({
      file: normalizePath(path.relative(root, filePath)),
      sourceText: await readFile(filePath, "utf8"),
    })),
  );
  violations.push(...forbiddenWorkflowReferences(files));

  if (violations.length > 0) {
    throw new Error(
      `Durable workflow removal contract failed:\n${violations.map((violation) => `- ${violation}`).join("\n")}`,
    );
  }
  return {
    filesScanned: files.length,
    removedArtifacts: removedWorkflowArtifactPaths.length,
  };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  verifyWorkflowRemoval()
    .then(({ filesScanned, removedArtifacts }) => {
      console.log(
        `Durable workflow removal contract passes (${filesScanned} files scanned; ${removedArtifacts} retired artifacts absent).`,
      );
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
}
