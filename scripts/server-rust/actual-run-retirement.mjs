// Exercise the existing browser Run API and full worker with a real child process.
import assert from "node:assert/strict";
import { mkdir, writeFile, readFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eventually } from "./full-worker.mjs";

export async function startRetirementProbe({
  page,
  root,
  projectId,
  primary,
  worktree,
  result,
}) {
  const configurationId = randomUUID();
  const pidPath = path.join(root, `run-retirement-${configurationId}.pid`);
  const exitPath = path.join(root, `run-retirement-${configurationId}.exit`);
  const scriptPath = path.join(root, `run-retirement-${configurationId}.cjs`);
  await writeFile(
    scriptPath,
    `
const fs = require('node:fs');
const target = ${JSON.stringify(worktree.path)};
process.on('SIGTERM', () => {
  fs.writeFileSync(${JSON.stringify(exitPath)}, JSON.stringify({directoryPresent:fs.existsSync(target),pid:process.pid}));
  process.exit(0);
});
fs.writeFileSync(${JSON.stringify(pidPath)}, String(process.pid));
setInterval(() => {}, 1000);
`,
  );
  const definitions = path.join(primary, ".cantrip", "run-configurations");
  await mkdir(definitions, { recursive: true });
  await writeFile(
    path.join(definitions, `${configurationId}.json`),
    JSON.stringify({
      schema: "cantrip.run-configuration",
      version: 1,
      id: configurationId,
      name: "Retirement process acceptance",
      provider: "shell",
      target: {
        kind: "command",
        command: `${JSON.stringify(process.execPath)} ${JSON.stringify(scriptPath)}`,
      },
      environment: { includeCodexEnvironment: false },
      stop: { gracePeriodMs: 3000 },
    }),
  );
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
  result.actualRunRetirement = {
    configurationId,
    runtimeId: admitted.runtime.id,
    terminalId: admitted.runtime.terminalId,
    pid: Number(pid),
  };
  result.steps.push(
    "existing browser Run API starts a real long-lived worker child in the secondary worktree",
  );
  return async () => {
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
    result.actualRunRetirement.exit = exited;
    result.steps.push(
      "worktree deletion stops the real Run child before removing its directory and retires durable runtime state",
    );
  };
}
