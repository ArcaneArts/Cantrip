import { prepareRunDefinition } from "./actual-run-definitions.mjs";
// Exercise the existing browser Run API and full worker with a real child process.
import assert from "node:assert/strict";
import { writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { eventually } from "./full-worker.mjs";

export async function startRetirementProbe({
  page,
  root,
  projectId,
  primary,
  worktree,
  result,
  deleteDefinition = false,
}) {
  const configurationId = randomUUID();
  const secret = randomUUID();
  const secretPath = path.join(root, `run-secret-${configurationId}.sha256`);
  const pidPath = path.join(root, `run-retirement-${configurationId}.pid`);
  const exitPath = path.join(root, `run-retirement-${configurationId}.exit`);
  const scriptPath = path.join(root, `run-retirement-${configurationId}.cjs`);
  await writeFile(
    scriptPath,
    `
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(secretPath)}, require('node:crypto').createHash('sha256').update(process.env.ACCEPTANCE_RUN_SECRET || '').digest('hex'));
const target = ${JSON.stringify(worktree.path)};
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify({directoryPresent:fs.existsSync(target),pid:process.pid}));
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const definitionPath = path.join(
    primary,
    ".cantrip",
    "run-configurations",
    `${configurationId}.json`,
  );
  const definition = await prepareRunDefinition({
    page,
    projectId,
    definitionPath,
    secret,
    result,
    document: {
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Retirement process acceptance",
      provider: "shell",
      target: {
        kind: "command",
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      },
      environment: {
        includeCodexEnvironment: false,
        secrets: [{ name: "ACCEPTANCE_RUN_SECRET", secret: "run/acceptance" }],
      },
      stop: { gracePeriodMs: 3000 },
    },
  });
  const admitted = await page.evaluate(
    async ({ projectId, configurationId, worktreeId }) => {
      const api = await import("/src/lib/run-configuration-api.ts");
      return api.operateRunConfigurationRuntime({
        projectId,
        configurationId,
        targetWorktreeId: worktreeId,
        operation: "start",
      });
    },
    { projectId, configurationId, worktreeId: worktree.id },
  );
  assert.equal(admitted.operation.outcome, "accepted");
  const pid = await eventually(
    () =>
      readFile(pidPath, "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    (value) => assert.ok(Number(value) > 0),
  );
  process.kill(Number(pid), 0);
  assert.equal(
    await readFile(secretPath, "utf8"),
    createHash("sha256").update(secret).digest("hex"),
  );
  result.steps.push(
    "the real worker decrypts the browser-protected Run secret for its child process",
  );
  const evidence = {
    configurationId,
    runtimeId: admitted.runtime.id,
    terminalId: admitted.runtime.terminalId,
    pid: Number(pid),
  };
  result.steps.push(
    "existing browser Run API starts a real long-lived worker child in the secondary worktree",
  );
  result[
    deleteDefinition ? "actualDefinitionRetirement" : "actualRunRetirement"
  ] = evidence;
  return async () => {
    if (deleteDefinition) {
      const stale = await page.evaluate(
        async ({ projectId, configurationId, revision }) => {
          const api = await import("/src/lib/run-configuration-api.ts");
          return api.deleteRunConfiguration(
            projectId,
            configurationId,
            revision,
          );
        },
        { projectId, configurationId, revision: definition.staleRevision },
      );
      assert.equal(stale.outcome, "revision-mismatch");
      process.kill(Number(pid), 0);
      const deleted = await page.evaluate(
        async ({ projectId, configurationId, revision }) => {
          const api = await import("/src/lib/run-configuration-api.ts");
          return api.deleteRunConfiguration(
            projectId,
            configurationId,
            revision,
          );
        },
        { projectId, configurationId, revision: definition.revision },
      );
      assert.equal(deleted.outcome, "deleted");
      await assert.rejects(readFile(definitionPath), { code: "ENOENT" });
    }

    const exited = JSON.parse(await readFile(exitPath, "utf8"));
    assert.equal(exited.pid, Number(pid));
    assert.equal(
      exited.directoryPresent,
      true,
      "Run receives termination before its worktree directory disappears",
    );
    assert.throws(() => process.kill(Number(pid), 0), { code: "ESRCH" });
    const remaining = await page.evaluate(
      async ({ projectId, configurationId, worktreeId }) => {
        const api = await import("/src/lib/run-configuration-api.ts");
        return api.listRunConfigurationRuntimes(projectId, {
          configurationId,
          targetWorktreeId: worktreeId,
        });
      },
      { projectId, configurationId, worktreeId: worktree.id },
    );
    assert.deepEqual(remaining, []);
    evidence.exit = exited;
    result.steps.push(
      deleteDefinition
        ? "definition deletion stops the real Run child, removes its definition file and retires durable runtime state"
        : "worktree deletion stops the real Run child before removing its directory and retires durable runtime state",
    );
  };
}
