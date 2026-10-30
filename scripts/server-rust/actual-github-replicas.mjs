// Real public GitHub reads/clones through gh and the unchanged full workers.
// All server state and checkouts belong to the disposable acceptance fixture.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath, stat, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";

export async function actualGithubReplicas({
  page,
  fixture,
  primaryWorkerId,
  secondaryWorkerId,
  primaryDataDirectory,
  secondaryDataDirectory,
  result,
  diagnostics,
}) {
  const remote = JSON.parse(
    execFileSync(
      "gh",
      ["repo", "view", "octocat/Hello-World", "--json", "id,nameWithOwner,url"],
      { encoding: "utf8", timeout: 30000 },
    ),
  );
  const repository = {
    repositoryId: remote.id,
    nameWithOwner: remote.nameWithOwner,
    url: remote.url,
  };
  const requests = [];
  const capture = (request) => {
    if (/\/api\/(?:projects|project-replica-jobs\/)/.test(request.url()))
      requests.push({ url: request.url(), body: request.postData() });
  };
  page.on("request", capture);
  const call = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) => {
        return (await import("/src/lib/api/project-replicas.ts"))[operation](
          ...args,
        );
      },
      { operation, args },
    );
  const waitJob = (id, attempt = 1) =>
    eventually(
      () => call("getProjectReplicaJob", [id]),
      (job) => {
        assert.equal(job.state, "succeeded", JSON.stringify(job));
        assert.equal(job.attempt, attempt);
        assert.equal(job.error, null);
      },
      120000,
    );
  const git = (directory, ...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
    }).trim();
  const ownedPath = async (directory, checkout) => {
    const relative = path.relative(
      await realpath(directory),
      await realpath(checkout),
    );
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "managed checkout belongs to disposable worker data",
    );
  };
  try {
    const project = await page.evaluate(
      async ({ repository, workerId }) =>
        window.folderCrypto.createGithubProject({ ...repository, workerId }),
      { repository, workerId: primaryWorkerId },
    );
    assert.equal(project.github.nameWithOwner, remote.nameWithOwner);
    const projectId = project.id;
    await page.evaluate((projectId) => {
      window.replicaLive.retainScope({ kind: "project", projectId });
    }, projectId);
    await eventually(
      () => page.evaluate(() => window.replicaLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
    const [importJob] = await call("getProjectReplicaJobs", [projectId]);
    assert.ok(importJob);
    const imported = await waitJob(importJob.id);
    const [primary] = await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        assert.equal(replicas.length, 1);
        assert.equal(replicas[0].ready, true);
        assert.equal(replicas[0].workerId, primaryWorkerId);
        assert.notEqual(replicas[0].path, "Protected path unavailable");
      },
    );
    await ownedPath(primaryDataDirectory, primary.path);
    assert.equal(primary.ownershipKind, "cantrip");
    assert.equal(primary.placementMode, "managed");
    assert.equal((await stat(primary.path)).isDirectory(), true);
    const revision = git(primary.path, "rev-parse", "HEAD");
    assert.equal(primary.head, revision);
    const trackedFile = git(primary.path, "ls-files", "-z").split("\0")[0];
    assert.ok(trackedFile);
    const contents = await readFile(path.join(primary.path, trackedFile));
    result.steps.push(
      "existing encrypted browser imports public GitHub repository through real gh clone and full worker into a managed checkout",
    );
    const provision = await call("createProjectReplica", [
      projectId,
      {
        workerId: secondaryWorkerId,
        repository,
        expectedRevision: revision,
        placement: { mode: "managed" },
        idempotencyKey: "actual-github-replica",
      },
    ]);
    const provisioned = await waitJob(provision.id);
    const replicas = await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        assert.equal(replicas.length, 2);
        assert.ok(replicas.every((value) => value.ready));
        assert.ok(
          replicas.every(
            (value) => value.path !== "Protected path unavailable",
          ),
        );
      },
    );
    const secondary = replicas.find(
      (value) => value.workerId === secondaryWorkerId,
    );
    assert.ok(secondary);
    await ownedPath(secondaryDataDirectory, secondary.path);
    assert.equal(secondary.ownershipKind, "cantrip");
    assert.equal(secondary.head, revision);
    assert.equal(git(secondary.path, "rev-parse", "HEAD"), revision);
    assert.deepEqual(
      await readFile(path.join(secondary.path, trackedFile)),
      contents,
    );
    const replay = await call("createProjectReplica", [
      projectId,
      {
        workerId: secondaryWorkerId,
        repository,
        expectedRevision: revision,
        placement: { mode: "managed" },
        idempotencyKey: "actual-github-replica",
      },
    ]);
    assert.equal(replay.id, provision.id);
    result.steps.push(
      "second full worker clones an exact managed GitHub replica; checkout contents and idempotent admission match",
    );
    const sync = await call("synchronizeProjectReplica", [
      projectId,
      secondary.id,
      {
        repository,
        expectedRevision: revision,
        policy: "verify-only",
        idempotencyKey: "actual-github-sync",
      },
    ]);
    const synchronized = await waitJob(sync.id);
    assert.equal(synchronized.resolvedRevision, revision);
    assert.equal(git(secondary.path, "rev-parse", "HEAD"), revision);
    result.steps.push(
      "encrypted synchronization uses real Git fetch and verifies the exact managed replica revision",
    );
    const ignoredName = "private-replica-user-data.tmp";
    const ignoreRules = path.join(
      secondaryDataDirectory,
      "acceptance-ignore-rules",
    );
    const ignoredPath = path.join(secondary.path, ignoredName);
    await writeFile(ignoreRules, `/${ignoredName}\n`);
    git(secondary.path, "config", "--local", "core.excludesFile", ignoreRules);
    const privateContents =
      "Ignored user data must survive index retirement.\n";
    await writeFile(ignoredPath, privateContents);
    assert.equal(
      git(
        secondary.path,
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "--",
        ignoredName,
      ),
      ignoredName,
    );
    const derivedCacheObserved = await stat(
      path.join(secondary.path, ".codegraph-cantrip"),
    ).then(
      (entry) => entry.isDirectory(),
      () => false,
    );
    const removal = await call("removeProjectReplica", [
      projectId,
      secondary.id,
      {
        repository,
        deleteLocalFiles: true,
        idempotencyKey: "actual-github-remove",
      },
    ]);
    const blocked = await eventually(
      () => call("getProjectReplicaJob", [removal.id]),
      (job) => {
        assert.equal(job.state, "blocked");
        assert.deepEqual(job.error, {
          code: "worktree-dirty",
          retryable: false,
        });
      },
    );
    assert.equal(await readFile(ignoredPath, "utf8"), privateContents);
    if (derivedCacheObserved)
      await eventually(diagnostics, (output) =>
        assert.ok(output.includes("event=codegraph.project.retired")),
      );
    result.steps.push(
      "managed index retirement preserves ignored user data and the real worker refuses checkout deletion",
    );
    await rm(ignoredPath);
    await call("retryProjectReplicaJob", [
      removal.id,
      { stateRevision: blocked.stateRevision },
    ]);
    const removed = await waitJob(removal.id, 2);
    await eventually(
      () => call("getProjectReplicas", [projectId]),
      (replicas) => {
        assert.equal(replicas.length, 1);
        assert.equal(replicas[0].id, primary.id);
        assert.equal(replicas[0].ready, true);
      },
    );
    await assert.rejects(stat(secondary.path), { code: "ENOENT" });
    assert.deepEqual(
      await readFile(path.join(primary.path, trackedFile)),
      contents,
    );
    assert.equal(git(primary.path, "rev-parse", "HEAD"), revision);
    const wire = await page.evaluate(
      async (id) =>
        (await window.folderWire.getProjectWireList()).find(
          (project) => project.id === id,
        ),
      projectId,
    );
    assert.equal(wire.capabilities.github, true);
    assert.ok(
      wire.replicas.every((value) =>
        /^ctrr_[A-Za-z0-9_-]{43}$/.test(value.path),
      ),
    );
    for (const secret of [
      remote.nameWithOwner,
      remote.url,
      primary.path,
      secondary.path,
    ])
      assert.equal(
        JSON.stringify(requests).includes(secret),
        false,
        "GitHub identity and managed paths remain opaque on HTTP",
      );
    // Clone progress reflects the actual external CLI stream; its count may vary.
    // Require every admitted job's completion event and preserve the raw sequence.
    const jobs = [imported, provisioned, synchronized, removed];
    const liveEvents = await eventually(
      () =>
        page.evaluate(
          (projectId) =>
            window.replicaEvents.filter(
              (event) =>
                event.resource === "project-replica-job" &&
                event.scope.projectId === projectId,
            ),
          projectId,
        ),
      (events) => {
        for (const job of jobs)
          assert.ok(
            events.some(
              (event) =>
                event.entityId === job.id &&
                event.revision === job.stateRevision,
            ),
          );
      },
    );
    result.actualGithubReplica = {
      repository,
      projectId,
      imported,
      provisioned,
      synchronized,
      removed,
      blocked,
      derivedCacheObserved,
      primary,
      secondary,
      requests,
      liveEvents,
    };
    result.githubReplicaSummary = {
      imported: imported.state,
      provisioned: provisioned.state,
      synchronized: synchronized.state,
      removed: removed.state,
      secondaryDeleted: true,
      primaryRetained: true,
    };
    result.steps.push(
      "managed replica removal deletes only the second real checkout; protected metadata and primary content remain intact",
    );
  } catch (error) {
    result.actualGithubReplicaFailure = {
      message: error.message,
      stack: error.stack,
    };
    throw error;
  } finally {
    page.off("request", capture);
  }
}
