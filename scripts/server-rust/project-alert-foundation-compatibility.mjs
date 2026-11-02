import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { postgresFixture } from "./postgres-fixture.mjs";
import { repositoryRoot } from "./build.mjs";

const directory = await mkdtemp(path.join(tmpdir(), "cantrip-alert-postgres-"));
let postgres;
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repositoryRoot,
      env: { ...process.env, ...env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) =>
      code === 0
        ? resolve()
        : reject(new Error(`${command} exited ${code ?? signal}`)),
    );
  });
}
try {
  postgres = await postgresFixture(path.join(directory, "postgres"));
  const url = await postgres.database();
  const env = { CANTRIP_ALERT_TEST_DATABASE_URL: url };
  await run(
    "pnpm",
    [
      "--filter",
      "@cantrip/server",
      "exec",
      "vitest",
      "run",
      "test/project-alerts.test.ts",
      "test/project-alert-interactions.test.ts",
      "test/project-alert-workflows.test.ts",
      "--maxWorkers=1",
    ],
    env,
  );
  await run(
    process.execPath,
    [
      "scripts/server-rust/cargo.mjs",
      "test",
      "--test",
      "project_alerts",
      "--test",
      "project_alert_interactions",
      "--test",
      "project_alert_workflows",
      "--",
      "--nocapture",
    ],
    env,
  );
  const result = {
    suite: "project-alerts",
    database: "postgres",
    node: "passed",
    rust: "passed",
  };
  if (process.env.CANTRIP_ALERT_REPORT)
    await writeFile(
      process.env.CANTRIP_ALERT_REPORT,
      JSON.stringify(result, null, 2) + "\n",
    );
  console.log(JSON.stringify(result));
} finally {
  await postgres?.close();
  await rm(directory, { recursive: true, force: true });
}
