import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { settingsHttpFixture } from "./native-settings-http-fixture.mjs";
import {
  mcpSettingsHttpWorker,
  mcpSettingsMarker,
} from "./mcp-settings-http-worker.mjs";
import { runMcpSettingsHttpCases } from "./mcp-settings-http-cases.mjs";
import { repositoryFixture } from "./repository-fixture.mjs";
import { literal } from "./project-target-state.mjs";
const option = (key) => {
  const i = process.argv.indexOf(key);
  return i < 0 ? undefined : process.argv[i + 1];
};
const databaseMode = option("--database") ?? "pglite";
const root = await mkdtemp(path.join(tmpdir(), "cantrip-mcp-settings-http-"));
const report = {
  suite: "global-project-mcp-settings-http",
  databaseMode,
  completeReplacement: false,
  profiles: [],
};
let pg, h, controller, failure;
try {
  const executable = await buildRustExample("http-sql-fixture"),
    repositoryExecutable = await buildRustExample("project-repository-fixture"),
    passwordHash = await hashPassword(password);
  if (databaseMode !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of ["none", "password", "accounts"].filter(
    (p) => !option("--profile") || p === option("--profile"),
  )) {
    const outputs = [];
    report.profiles.push({ profile, outputs });
    for (const kind of ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        commands: [],
        snapshotProofs: 0,
        cryptoProofs: 0,
        sqlDiagnosticProofs: 0,
        durable: [],
        recovery: [],
        effective: [],
      };
      outputs.push(result);
      controller = await mcpSettingsHttpWorker(
        result,
        () => h,
        path.join(root, profile, kind),
      );
      h = await settingsHttpFixture({
        kind,
        profile,
        root,
        executable,
        repositoryExecutable,
        databaseMode,
        passwordHash,
        result,
        liveSqlFixture: true,
        url:
          pg && (kind === "node" || databaseMode === "postgres")
            ? await pg.database()
            : undefined,
        environment: { CANTRIP_WORKER_COMMAND_CONCURRENCY: "2" },
        configure: () => [
          `UPDATE project_sources SET absolute_path=${literal(controller.projectRoot)},display_path=${literal(controller.projectRoot)} WHERE id='settings-source'`,
          `UPDATE project_worktrees SET absolute_path=${literal(controller.projectRoot)},display_path=${literal(controller.projectRoot)} WHERE id='33333333-3333-4333-8333-333333333333'`,
        ],
        onCommand: controller.onCommand,
      });
      try {
        await runMcpSettingsHttpCases({
          h,
          profile,
          result,
          controller,
          openRepository: () =>
            repositoryFixture({
              kind,
              executable: repositoryExecutable,
              root: path.join(root, profile),
              databaseMode,
              databaseUrl: h.fixture.environment.DATABASE_URL,
            }),
        });
        result.observations = controller.canonical(result.observations);
        for (const value of [...h.fixture.records.values(), h.diagnostics()])
          assert.equal(
            JSON.stringify(value).includes(mcpSettingsMarker),
            false,
            "MCP plaintext stays at endpoints",
          );
      } finally {
        result.diagnostics = h.diagnostics();
        controller.release();
        await h.close();
        h = null;
      }
    }
    for (const field of [
      "observations",
      "commands",
      "cryptoProofs",
      "sqlDiagnosticProofs",
      "durable",
      "recovery",
      "effective",
    ])
      assert.deepEqual(
        outputs[1][field],
        outputs[0][field],
        profile + " " + field,
      );
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.passed = false;
  report.error = error.stack ?? String(error);
  report.retainedRoot = root;
} finally {
  controller?.release();
  await h?.close();
  await pg?.close();
  const reportPath = option("--report");
  if (reportPath) {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    suite: report.suite,
    databaseMode,
    profiles: report.profiles.length,
    passed: true,
  }),
);
