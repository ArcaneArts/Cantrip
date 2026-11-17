import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { readFile, writeFile, lstat } from "node:fs/promises";
import path from "node:path";
const execute = promisify(execFile);
export async function verifyReplicaLifecycleJobs({
  call,
  fixture,
  workerId,
  completed,
  eventually,
  seedSiblings,
}) {
  let jobs = 0;
  const env = { ...process.env, ...fixture.environment };
  const git = async (...args) =>
    (
      await execute(fixture.environment.CANTRIP_REPLICA_FIXTURE_GIT, args, {
        env,
      })
    ).stdout.trim();
  function privateWire(body) {
    assert.equal(JSON.stringify(body).includes(fixture.root), false);
  }
  async function settle(id, expected = "succeeded") {
    const result = await eventually(
      () => call("GET", "/api/project-replica-jobs/" + id),
      (result) => {
        assert.equal(result.status, 200, JSON.stringify(result));
        privateWire(result.body);
        assert.equal(result.body.state, expected, JSON.stringify(result.body));
      },
      "native replica " + expected + " job",
    );
    return result.body;
  }
  async function operation(entry, type, input) {
    const route =
      "/api/projects/" +
      entry.project.id +
      "/replicas/" +
      entry.source.id +
      "/" +
      type;
    const body = {
      repository: entry.project.repository,
      idempotencyKey: randomUUID(),
      ...input,
    };
    const response = await call("POST", route, body);
    assert.equal(response.status, 202, JSON.stringify(response));
    privateWire(response.body);
    jobs++;
    return { id: response.body.id, body, route };
  }
  const managed = completed.find((entry) => entry.project.mode === "managed");
  const direct = completed.find((entry) => entry.project.mode === "direct");
  const link = completed.find((entry) => entry.project.mode === "managed-link");
  await seedSiblings(completed);
  const current = await git("-C", managed.path, "rev-parse", "HEAD");
  const verify = await operation(managed, "synchronize", {
    expectedRevision: current,
    policy: "verify-only",
  });
  await settle(verify.id);
  await writeFile(
    path.join(fixture.seed, "README.md"),
    "Advanced through native server job\n",
  );
  await git("-C", fixture.seed, "add", "README.md");
  await git("-C", fixture.seed, "commit", "-m", "Native durable sync");
  const advanced = await git("-C", fixture.seed, "rev-parse", "HEAD");
  await git("-C", fixture.seed, "push", fixture.remote, "main");
  const forward = await operation(managed, "synchronize", {
    expectedRevision: advanced,
    policy: "fast-forward-primary",
  });
  await settle(forward.id);
  assert.equal(await git("-C", managed.path, "rev-parse", "HEAD"), advanced);
  const replay = await call("POST", forward.route, forward.body);
  assert.equal(replay.status, 202, JSON.stringify(replay));
  assert.equal(replay.body.id, forward.id);
  const retain = await operation(direct, "remove", { deleteLocalFiles: false });
  await settle(retain.id);
  assert.equal(
    await readFile(path.join(direct.path, "README.md"), "utf8"),
    "Owned replica fixture\n",
  );
  await assert.rejects(
    lstat(path.join(direct.path, ".git", "cantrip-project-owner.json")),
    { code: "ENOENT" },
  );
  const removedLink = await operation(link, "remove", {
    deleteLocalFiles: true,
  });
  await settle(removedLink.id);
  await assert.rejects(lstat(link.path), { code: "ENOENT" });
  await assert.rejects(lstat(link.project.target), { code: "ENOENT" });
  const removedManaged = await operation(managed, "remove", {
    deleteLocalFiles: true,
  });
  await settle(removedManaged.id);
  await assert.rejects(lstat(managed.path), { code: "ENOENT" });
  const sources = await call(
    "GET",
    "/api/projects/" + managed.project.id + "/replicas",
  );
  assert.equal(sources.status, 200);
  assert.equal(
    sources.body.some((source) => source.workerId === workerId),
    false,
  );
  // Retention removes ownership. Reattachment must classify this checkout as
  // user-owned; a later delete request may not reclaim it.
  const reattach = await call(
    "POST",
    "/api/projects/" + direct.project.id + "/replicas",
    {
      workerId,
      repository: direct.project.repository,
      placement: { mode: "direct", path: direct.project.placementPath },
      expectedRevision: null,
      idempotencyKey: randomUUID(),
    },
  );
  assert.equal(reattach.status, 202, JSON.stringify(reattach));
  jobs++;
  await settle(reattach.body.id);
  const attached = await call(
    "GET",
    "/api/projects/" + direct.project.id + "/replicas",
  );
  assert.equal(attached.status, 200);
  const userSource = attached.body.find(
    (source) => source.workerId === workerId,
  );
  assert.equal(userSource.ownershipKind, "user");
  const denied = await call(
    "POST",
    "/api/projects/" +
      direct.project.id +
      "/replicas/" +
      userSource.id +
      "/remove",
    {
      repository: direct.project.repository,
      idempotencyKey: randomUUID(),
      deleteLocalFiles: true,
    },
  );
  assert.equal(denied.status, 409, JSON.stringify(denied));
  assert.equal(
    denied.body.error,
    "This checkout existed before Cantrip and cannot be deleted.",
  );
  assert.equal(
    await readFile(path.join(direct.path, "README.md"), "utf8"),
    "Owned replica fixture\n",
  );
  const trace = (await readFile(fixture.trace, "utf8"))
    .split("\0\0")
    .filter(Boolean)
    .map((row) => row.split("\0"));
  assert.equal(
    trace.filter((row) => row[0] === "git" && row.includes("--ff-only")).length,
    1,
    "idempotent request never repeats merge",
  );
  return {
    durableReplicaLifecycleJobs: jobs,
    verifyAndFastForwardThroughServer: true,
    idempotentSyncNotReexecuted: true,
    retainedDirectCheckout: true,
    actualManagedAndLinkDeletion: true,
    reattachedCheckoutIsUserOwned: true,
    userOwnedDeletionDenied: true,
  };
}
