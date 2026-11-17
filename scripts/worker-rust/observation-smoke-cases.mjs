// Production binaries: worker notifications -> committed server snapshots ->
// authenticated app live events. No status-command polling supplies this proof.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile, rm, readFile } from "node:fs/promises";
import path from "node:path";
import { LiveProbe } from "../server-rust/live-sockets.mjs";
import { WorkerRoutingRegistry } from "../../cantrip_worker/src/routing-registry.ts";
export async function verifyNativeObservations({
  call,
  origin,
  projectId,
  workerId,
  workerDirectory,
  checkout,
  restartWorker,
}) {
  // Explicit worker IDs do not create the optional generated-ID file.
  const identity = await readFile(
    path.join(workerDirectory, "worker-encryption-key.json"),
    "utf8",
  );
  const probe = await new LiveProbe({
    server: { origin },
    client: () => ({ cookies: new Map() }),
  }).open();
  const file = "private-native-observation.txt";
  let phase = "initialize";
  try {
    await probe.initialized();
    await probe.subscribed("native-observation", [
      { kind: "project", projectId },
    ]);
    const inventory = await call("GET", `/api/projects/${projectId}/worktrees`);
    assert.equal(inventory.status, 200, JSON.stringify(inventory));
    const primary = inventory.body.find(
      (tree) => tree.workerId === workerId && tree.isPrimary,
    );
    assert.ok(primary);
    const event = (resource) => (frame) =>
      frame.type === "event" &&
      frame.resource === resource &&
      frame.entityId === primary.id;
    const resolve = async (token) =>
      (
        await new WorkerRoutingRegistry(workerDirectory).resolveMetadata({
          path: token,
        })
      ).path;
    const git = (...args) =>
      execFileSync("git", ["-C", checkout, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    // A real metadata-only update establishes that asynchronous configuration
    // and watcher setup completed before testing a single filesystem event.
    phase = "initial metadata update";
    git(
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "Observation metadata update",
    );
    const initialHead = git("rev-parse", "HEAD");
    let status;
    do {
      status = await probe.message(event("worktree-status"));
    } while (status.payload.head !== initialHead);
    phase = "filesystem invalidation";
    await writeFile(path.join(checkout, file), "observed before restart\n");
    const invalidated = await probe.message(event("explorer-filesystem"));
    assert.equal(invalidated.payload, null);
    phase = "file status publication";
    do {
      status = await probe.message(event("worktree-status"));
    } while (
      !(
        await Promise.all(
          status.payload.files.map((entry) => resolve(entry.path)),
        )
      ).includes(file)
    );
    assert.equal(
      JSON.stringify(status).includes(file),
      false,
      "server event contains opaque file paths",
    );
    assert.equal(
      JSON.stringify(status).includes(checkout),
      false,
      "source path remains private",
    );
    git("add", "--", file);
    git("commit", "--quiet", "-m", "Native observed commit");
    const head = git("rev-parse", "HEAD");
    phase = "committed HEAD publication";
    do {
      status = await probe.message(event("worktree-status"));
    } while (status.payload.head !== head);
    await restartWorker();
    phase = "restart identity and observation";
    assert.equal(
      await readFile(
        path.join(workerDirectory, "worker-encryption-key.json"),
        "utf8",
      ),
      identity,
    );
    await writeFile(path.join(checkout, file), "observed after restart\n");
    do {
      status = await probe.message(event("worktree-status"));
    } while (
      !(
        await Promise.all(
          status.payload.files.map((entry) => resolve(entry.path)),
        )
      ).includes(file)
    );
    assert.equal(status.payload.head, head);
    assert.equal(JSON.stringify(status).includes(file), false);
    return {
      liveFilesystemInvalidation: true,
      committedLiveGitStatus: true,
      metadataHeadUpdates: true,
      opaqueNotificationMetadata: true,
      workerRestartAndIdentity: true,
    };
  } catch (error) {
    console.error(
      JSON.stringify({ phase, liveHistory: probe.history.slice(-12) }),
    );
    throw error;
  } finally {
    await probe.close();
    await rm(path.join(checkout, file), { force: true });
  }
}
