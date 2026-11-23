// Production durable import jobs and link repair through the production server.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, rm, realpath, lstat } from "node:fs/promises";
import path from "node:path";
import { WorkerRoutingRegistry } from "../../tests/reference-node-worker/src/routing-registry.ts";
import { projectLabel } from "../server-rust/security-fixtures.mjs";
export async function verifyReplicaProvision({
  lifecycle,
  seedSiblings,
  call,
  fixture,
  workerId,
  workerDirectory,
  root,
  registerMetadata,
  restartWorker,
  eventually,
}) {
  const completed = [];
  let ordinal = 0;
  function privateWire(body) {
    const text = JSON.stringify(body);
    for (const privateValue of [
      root,
      workerDirectory,
      "fixture/repository",
      "fixture/direct",
      "fixture/link",
      "fixture/held",
    ])
      assert.equal(
        text.includes(privateValue),
        false,
        "replica wire keeps metadata private: " + privateValue,
      );
  }
  async function job(
    projectId,
    accept = (job) => assert.equal(job.state, "succeeded"),
  ) {
    let selected;
    await eventually(
      () => call("GET", "/api/projects/" + projectId + "/replica-jobs"),
      (result) => {
        assert.equal(result.status, 200, JSON.stringify(result));
        assert.equal(result.body.length, 1);
        privateWire(result.body);
        selected = result.body[0];
        accept(selected);
      },
      "replica durable job " + projectId,
    );
    return selected;
  }
  async function replicas(projectId) {
    const result = await call(
      "GET",
      "/api/projects/" + projectId + "/replicas",
    );
    assert.equal(result.status, 200, JSON.stringify(result));
    privateWire(result.body);
    return result.body;
  }
  async function create(name, mode = "managed") {
    const id = randomUUID();
    const target = path.join(root, "placements", name);
    const values = {
      repositoryId: String(1000 + ordinal),
      nameWithOwner: "fixture/" + name,
      url: "https://github.com/fixture/" + name,
      ...(mode === "managed" ? {} : { path: target }),
    };
    const registered = await registerMetadata("native-replica-" + name, values);
    const result = await call("POST", "/api/projects/from-github", {
      id,
      workerId,
      nameProtection: projectLabel,
      repositoryBlindIndex: Buffer.alloc(32, ++ordinal).toString("base64url"),
      repositoryId: registered.repositoryId,
      nameWithOwner: registered.nameWithOwner,
      url: registered.url,
      placement:
        mode === "managed" ? { mode } : { mode, path: registered.path },
    });
    assert.equal(result.status, 202, JSON.stringify(result));
    privateWire(result.body);
    return {
      id,
      target,
      mode,
      repository: registered.nameWithOwner,
      placementPath: registered.path,
    };
  }
  async function ready(project) {
    const settled = await job(project.id);
    assert.equal(settled.progress.stage, "succeeded");
    assert.equal(settled.resolvedMaterialization, "cloned");
    const sources = await replicas(project.id);
    assert.equal(sources.length, 1);
    const source = sources[0];
    assert.equal(source.placementMode, project.mode);
    assert.equal(source.ownershipKind, "cantrip");
    const registry = new WorkerRoutingRegistry(workerDirectory);
    const resolved = await registry.resolveMetadata({ path: source.path });
    assert.match(source.repositoryFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(
      await readFile(path.join(resolved.path, "README.md"), "utf8"),
      "Owned replica fixture\n",
    );
    if (project.mode === "direct")
      assert.equal(resolved.path, await realpath(project.target));
    if (project.mode === "managed-link")
      assert.equal(await realpath(project.target), resolved.path);
    completed.push({ project, source, path: resolved.path });
    return { source, resolved, settled };
  }
  const managed = await create("repository");
  await ready(managed);
  const direct = await create("direct", "direct");
  await ready(direct);
  const link = await create("link", "managed-link");
  const linked = await ready(link);
  await rm(link.target);
  const repairRoute =
    "/api/projects/" +
    link.id +
    "/replicas/" +
    linked.source.id +
    "/repair-link";
  const repaired = await call("POST", repairRoute, {});
  assert.equal(repaired.status, 200, JSON.stringify(repaired));
  assert.equal(repaired.body.repaired, true);
  privateWire(repaired.body);
  assert.equal(await realpath(link.target), linked.resolved.path);
  const replay = await call("POST", repairRoute, {});
  assert.equal(replay.status, 200, JSON.stringify(replay));
  assert.equal(replay.body.repaired, false);
  await rm(link.target);
  await writeFile(link.target, "preserve replaced link");
  const conflict = await call("POST", repairRoute, {});
  assert.equal(conflict.status, 409, JSON.stringify(conflict));
  assert.equal(conflict.body.code, "link-target-mismatch");
  assert.equal(await readFile(link.target, "utf8"), "preserve replaced link");
  await rm(link.target);
  assert.equal((await call("POST", repairRoute, {})).status, 200);
  await writeFile(fixture.behavior, "hold-once");
  const held = await create("held", "direct");
  const heldPidText = await eventually(
    () =>
      readFile(fixture.behavior + ".holding", "utf8").catch((error) => {
        if (error.code === "ENOENT") return null;
        throw error;
      }),
    (value) => assert.match(value?.trim() ?? "", /^[1-9][0-9]*$/u),
    "owned clone entered held external process",
  );
  const running = await job(held.id, (value) => {
    assert.equal(value.state, "running");
    assert.equal(value.progress.stage, "materializing");
    assert.equal(value.progress.percent, 30);
  });
  const staging = held.target + ".cantrip-provision-" + running.id;
  assert.ok((await lstat(staging + ".cantrip-owner.json")).isFile());
  await restartWorker();
  // Observe that the old owned child was reaped; its saved PID grants no
  // authority to terminate a process. The worker used its actual Child handle.
  assert.throws(() => process.kill(Number(heldPidText.trim()), 0), {
    code: "ESRCH",
  });
  const interrupted = await job(held.id, (value) => {
    assert.equal(value.attempt, 2, "existing reconnect retry");
    assert.equal(value.state, "blocked", JSON.stringify(value));
  });
  await assert.rejects(lstat(staging + ".cantrip-owner.json"), {
    code: "ENOENT",
  });
  await assert.rejects(lstat(staging), { code: "ENOENT" });
  await writeFile(fixture.behavior, "normal");
  const retry = await call(
    "POST",
    "/api/project-replica-jobs/" + interrupted.id + "/retry",
    { stateRevision: interrupted.stateRevision },
  );
  assert.equal(retry.status, 200, JSON.stringify(retry));
  const retried = await ready(held);
  assert.equal(retried.settled.attempt, 3);
  for (const entry of completed) {
    const sources = await replicas(entry.project.id);
    assert.equal(sources[0].id, entry.source.id);
    assert.equal(sources[0].path, entry.source.path);
    assert.equal(
      sources[0].repositoryFingerprint,
      entry.source.repositoryFingerprint,
    );
    assert.equal(
      await readFile(path.join(entry.path, "README.md"), "utf8"),
      "Owned replica fixture\n",
    );
  }
  const trace = (await readFile(fixture.trace))
    .toString()
    .split("\0\0")
    .filter(Boolean)
    .map((row) => row.split("\0"));
  const calls = trace.filter((row) => row[0] === "gh");
  for (const name of ["repository", "direct", "link"])
    assert.equal(
      calls.filter((row) => row[3] === "fixture/" + name).length,
      1,
      "completed clone not replayed",
    );
  assert.equal(
    calls.filter((row) => row[3] === "fixture/held").length,
    3,
    "interrupted clone follows existing reconnect retry and explicit blocked-job retry",
  );
  const extra = lifecycle
    ? await lifecycle({
        call,
        fixture,
        workerId,
        root,
        completed,
        seedSiblings,
        eventually,
      })
    : {};
  return {
    ...extra,
    durableProvisionJobs: 4,
    allPlacementModes: true,
    realNativeCloneAndFetch: true,
    protectedMetadataAndPersistedPaths: true,
    actualManagedLinkRepair: true,
    replacedLinkPreserved: true,
    progressEventDurablyObserved: true,
    heldOwnedCloneRetiredOnRestart: true,
    reconnectRetryAfterRestart: true,
    explicitRetryAfterBlockedResult: true,
    completedEffectsNotReplayed: true,
  };
}
