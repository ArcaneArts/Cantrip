import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const auditPath = "scripts/audit-run-configuration-cutover.mjs";
const intentionallyHistoricalPaths = new Set([
  "cantrip_server/test/run-configuration-cutover-migration.test.ts",
  "docs/RUN_CONFIGURATIONS.md",
  auditPath,
]);
const legacyIdentifiers = new Map([
  ["run_config_list", "run_configuration_list"],
  ["run_config_read", "run_configuration_get"],
  ["run_config_schema", "run_configuration_get or tool_help"],
  ["run_config_action_add", "run_configuration_create"],
  ["run_start", "run_configuration_start"],
  ["run_status", "run_configuration_status"],
  ["run_read", "run_configuration_read_output"],
  ["run_open", "run_configuration_read_output"],
  ["run_stop", "run_configuration_stop"],
  ["run_setup_status", "bounded pre-launch environment materialization"],
  ["run_setup_retry", "a new Run generation"],
  ["run_instances", "run_configuration_runtimes"],
  ["worktree_setup_jobs", "pre-launch environment materialization"],
  ["/api/run-instances", "the replacement Run configuration routes"],
  ["RunSupervisor", "RunConfigurationRuntimeSupervisor"],
  ["runInstances", "runConfigurationRuntimes"],
  ["worktreeSetupJobs", "pre-launch environment materialization"],
]);
const scanRoots = [
  "README.md",
  "docs",
  "cantrip_app/src",
  "cantrip_server/src",
  "cantrip_server/test",
  "cantrip_worker/src",
  "cantrip_worker/test",
  "packages",
  "scripts",
];

export async function auditRunConfigurationCutover(root = repositoryRoot) {
  const tracked = spawnSync(
    "git",
    [
      "ls-files",
      "--cached",
      "--others",
      "--exclude-standard",
      "-z",
      "--",
      ...scanRoots,
    ],
    {
      cwd: root,
      encoding: "buffer",
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  if (tracked.error) throw tracked.error;
  if (tracked.status !== 0)
    throw new Error(
      tracked.stderr.toString("utf8") || "Could not enumerate audit sources.",
    );

  const violations = [];
  for (const relativePath of new Set(
    tracked.stdout.toString("utf8").split("\0"),
  )) {
    if (!relativePath || intentionallyHistoricalPaths.has(relativePath))
      continue;
    let content;
    try {
      content = await readFile(path.join(root, relativePath), "utf8");
    } catch (error) {
      // Unstaged deletions remain in the index, but are not current source.
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (content.includes("\0")) continue;
    for (const [identifier, replacement] of legacyIdentifiers) {
      let offset = content.indexOf(identifier);
      while (offset >= 0) {
        const before = content.slice(0, offset);
        const line = before.split("\n").length;
        const column = offset - before.lastIndexOf("\n");
        violations.push({
          column,
          identifier,
          line,
          relativePath,
          replacement,
        });
        offset = content.indexOf(identifier, offset + identifier.length);
      }
    }
  }
  return violations;
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const violations = await auditRunConfigurationCutover();
  if (violations.length > 0) {
    console.error("Legacy Run configuration cutover references remain:");
    for (const violation of violations.sort(
      (left, right) =>
        left.relativePath.localeCompare(right.relativePath) ||
        left.line - right.line ||
        left.column - right.column,
    )) {
      console.error(
        `${violation.relativePath}:${violation.line}:${violation.column} ` +
          `${violation.identifier} (use ${violation.replacement})`,
      );
    }
    process.exitCode = 1;
  } else {
    console.log(
      "Active source and guidance contain only replacement Run configuration contracts",
    );
  }
}
