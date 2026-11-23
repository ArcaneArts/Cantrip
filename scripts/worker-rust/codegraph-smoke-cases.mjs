import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  cp,
  mkdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { LiveProbe } from "../server-rust/live-sockets.mjs";

const indexName = ".codegraph-cantrip";
const versionName = "fixture-distribution";

export async function stageCodeGraph({
  distribution,
  root,
  bin,
  workerDirectory,
}) {
  const home = path.join(root, "codegraph-home");
  await mkdir(home);
  await symlink("/usr/bin/dirname", path.join(bin, "dirname"));
  await symlink("/usr/bin/readlink", path.join(bin, "readlink"));
  const managed = path.join(workerDirectory, "tools", "codegraph");
  const staged = path.join(managed, "versions", versionName);
  const executable = `versions/${versionName}/bin/codegraph`;
  await mkdir(path.join(managed, "bin"), { recursive: true });
  await cp(path.resolve(distribution), staged, {
    recursive: true,
    mode: constants.COPYFILE_FICLONE,
  });
  const cli = path.join(managed, executable);
  const version = execFileSync(cli, ["--version"], {
    encoding: "utf8",
    env: { HOME: home, PATH: bin, DO_NOT_TRACK: "1" },
  }).trim();
  // Construct the legacy pointer for an already installed local vendor build.
  // This fixture supplies unpacked files and does not exercise archive download.
  await writeFile(
    path.join(managed, "bin", "current.json"),
    JSON.stringify({
      schemaVersion: 1,
      archiveSha256: createHash("sha256")
        .update(await readFile(cli))
        .digest("hex"),
      executable,
      packageDirectory: versionName,
      telemetryDisabled: true,
      verifiedAt: new Date().toISOString(),
      version,
    }),
  );
}

export async function verifyCodeGraph({
  call,
  eventually,
  origin,
  projectId,
  workerId,
  checkout,
  restartWorker,
}) {
  const workers = await eventually(
    () => call("GET", "/api/workers"),
    (response) => {
      assert.equal(response.status, 200);
      const worker = response.body.find((entry) => entry.workerId === workerId);
      assert.equal(
        worker?.codegraph?.runtimeState,
        "ready",
        JSON.stringify(worker),
      );
      assert.equal(worker.codegraph.cliAvailable, true);
      assert.equal(worker.codegraph.telemetryDisabled, true);
    },
    "installed CodeGraph heartbeat",
  );
  const worker = workers.body.find((entry) => entry.workerId === workerId);
  assert.match(worker.codegraph.installedVersion, /^\d+\.\d+\.\d+/u);
  const inventory = await call("GET", `/api/projects/${projectId}/worktrees`);
  assert.equal(inventory.status, 200, JSON.stringify(inventory));
  const primary = inventory.body.find(
    (entry) => entry.workerId === workerId && entry.isPrimary,
  );
  assert.ok(primary);
  const index = path.join(checkout, indexName);
  const probe = await new LiveProbe({
    server: { origin },
    client: () => ({ cookies: new Map() }),
  }).open();
  const route = `/api/projects/${projectId}/worktrees/${primary.id}/codegraph`;
  const git = (...args) =>
    execFileSync("git", ["-C", checkout, ...args], {
      encoding: "utf8",
    }).trim();
  const ready = (predicate) =>
    probe.message(
      (frame) =>
        frame.type === "event" &&
        frame.resource === "codegraph-status" &&
        frame.entityId === primary.id &&
        frame.payload.state === "ready" &&
        predicate(frame.payload),
    );
  try {
    await probe.initialized();
    await probe.subscribed("CodeGraph fixture", [
      { kind: "project", projectId },
    ]);
    // The worker's authenticated reconnect requests current observations from
    // Core, including this newly imported project.
    await restartWorker();
    await eventually(
      () => stat(index).catch(() => null),
      (entry) => assert.ok(entry?.isDirectory()),
      "observed CodeGraph project index",
    );
    assert.equal(git("check-ignore", `${indexName}/`), `${indexName}/`);
    const initial = await call("GET", route);
    assert.equal(initial.status, 200, JSON.stringify(initial));
    assert.equal(initial.body.projectId, projectId);
    const file = path.join(checkout, "observed-codegraph.ts");
    assert.ok(initial.body.fileCount === null || initial.body.fileCount === 0);
    await writeFile(file, "export function fixture() { return 42; }\n");
    const observed = await ready(
      (value) => value.fileCount === 1 && value.pendingChanges === 0,
    );
    assert.ok(observed.payload.nodeCount > 0);
    assert.equal(JSON.stringify(observed).includes(checkout), false);
    for (const action of ["sync", "rebuild"]) {
      const result = await call("POST", `${route}/${action}`, {});
      assert.equal(result.status, 202, JSON.stringify(result));
      assert.equal(result.body.action, action);
      const completed = await ready(
        (value) =>
          value.job?.id === result.body.jobId &&
          value.job.state === "completed",
      );
      assert.equal(completed.payload.fileCount, 1);
    }
    const excluded = git("rev-parse", "--git-path", "info/exclude");
    assert.equal(
      (await readFile(path.resolve(checkout, excluded), "utf8")).split(
        "# BEGIN CANTRIP CODEGRAPH",
      ).length,
      2,
    );
  } finally {
    await probe.close();
  }
}
