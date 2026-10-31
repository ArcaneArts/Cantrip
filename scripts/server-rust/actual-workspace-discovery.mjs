// Existing encrypted browser APIs and full worker, with actual disposable Git
// data. No catalog seeding, command replacement, or server-side filesystem IO.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { eventually } from "./full-worker.mjs";
import { actualGithubConversion } from "./actual-github-conversion.mjs";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";
export async function actualWorkspaceDiscovery({
  page,
  fixture,
  dataDirectory,
  workerId,
  startWorker,
  stopWorker,
  result,
}) {
  const root = path.join(dataDirectory, "private-attached-workspace"),
    checkout = path.join(root, "private-repository");
  await mkdir(root, { recursive: true });
  execFileSync(
    "git",
    [
      "clone",
      "--depth=1",
      "https://github.com/octocat/Hello-World.git",
      checkout,
    ],
    { encoding: "utf8", timeout: 90000 },
  );
  execFileSync("git", ["-C", checkout, "remote", "remove", "origin"], {
    encoding: "utf8",
    timeout: 15000,
  });
  const directory = normalizeProjectSourcePath(await realpath(checkout));
  const sentinel = path.join(directory, "private-uncommitted-conversion.txt"),
    contents = "Private uncommitted content survives conversion.\n";
  await writeFile(sentinel, contents);
  const calls = (module, operation, args = []) =>
    page.evaluate(
      async ({ module, operation, args }) =>
        (await import(module))[operation](...args),
      { module, operation, args },
    );
  const workspaces = (operation, args = []) =>
    calls("/src/lib/workspace-encryption.ts", operation, args);
  const discoveries = (operation, args = []) =>
    calls("/src/lib/api/discovery.ts", operation, args);
  const requests = [];
  const capture = (request) => {
    if (request.url().includes("/api/workspaces"))
      requests.push({
        url: request.url(),
        method: request.method(),
        body: request.postData(),
      });
  };
  page.on("request", capture);
  let workspace;
  try {
    await startWorker();
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
    await page.evaluate(() => window.folderLive.start());
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
    workspace = await workspaces("createProjectWorkspace", [
      {
        name: "Private attached workspace 🦀",
        storage: { kind: "attached", workerId, rootPath: root },
      },
    ]);
    assert.equal(workspace.storage.kind, "attached");
    assert.match(workspace.storage.rootPathHandle, /^ctrr_[A-Za-z0-9_-]{43}$/);
    const snapshot = await eventually(
      () => discoveries("getWorkspaceRepositoryDiscovery", [workspace.id]),
      (snapshot) => {
        assert.equal(snapshot.job.state, "succeeded", JSON.stringify(snapshot));
        assert.equal(snapshot.candidates.length, 1);
      },
      90000,
    );
    const candidate = snapshot.candidates[0];
    assert.equal(candidate.classification, "local-git");
    assert.equal(candidate.importState, "pending");
    assert.match(candidate.pathHandle, /^ctrr_[A-Za-z0-9_-]{43}$/);
    result.steps.push(
      "existing encrypted browser attaches an actual private root and the full worker discovers its local Git checkout through opaque routing handles",
    );
    const prepared = await page.evaluate(
      ({ candidateId, workerId }) =>
        window.folderCrypto.prepareWorkspaceRepositoryImport({
          candidateId,
          workerId,
          name: "Private discovered repository 🌌",
          repository: null,
        }),
      { candidateId: candidate.id, workerId },
    );
    await discoveries("startWorkspaceRepositoryImports", [
      workspace.id,
      {
        expectedStateRevision: snapshot.job.stateRevision,
        candidates: [prepared],
      },
    ]);
    const imported = await eventually(
      () => discoveries("getWorkspaceRepositoryDiscovery", [workspace.id]),
      (snapshot) => {
        assert.equal(snapshot.candidates[0].importState, "imported");
        assert.equal(snapshot.candidates[0].projectId, prepared.projectId);
      },
      90000,
    );
    const project = await eventually(
      () => page.evaluate(() => window.folderCrypto.getProjects()),
      (projects) => {
        const project = projects.find((p) => p.id === prepared.projectId);
        assert.ok(project);
        assert.equal(project.source.path, directory);
        assert.equal(project.source.ownershipKind, "user");
        assert.equal(project.source.placementMode, "direct");
        assert.equal(project.worktreePolicy, "direct");
        assert.equal(project.folderManagement, "external");
        assert.equal(project.capabilities.git, true);
      },
    );
    assert.equal(await readFile(sentinel, "utf8"), contents);
    const listed = await workspaces("getProjectWorkspaces");
    assert.ok(
      listed
        .find((w) => w.id === workspace.id)
        .projectIds.includes(prepared.projectId),
    );
    const wire = await page.evaluate(() =>
      window.folderWire.getProjectWireList(),
    );
    const primary = wire.find((p) => p.id === prepared.projectId).replicas[0]
      .primaryWorktreeId;
    assert.ok(primary);
    result.steps.push(
      "actual worker import creates the project, immutable workspace membership, user-owned direct source and Primary worktree while retaining dirty files",
    );
    const events = await eventually(
      () =>
        page.evaluate(
          (id) =>
            window.folderEvents.filter(
              (e) =>
                e.resource === "workspace-repository-discovery-job" &&
                e.entityId === id &&
                e.revision !== null,
            ),
          workspace.id,
        ),
      (events) =>
        assert.ok(
          events.some((e) => e.revision === imported.job.stateRevision),
        ),
    );
    const revisions = events.map((e) => e.revision);
    assert.equal(revisions[0], 1);
    for (let i = 1; i < revisions.length; i++)
      assert.ok(revisions[i] >= revisions[i - 1]);
    await stopWorker();
    await actualGithubConversion({
      page,
      fixture,
      dataDirectory,
      workerId,
      startWorker,
      stopWorker,
      result,
      externalSource: {
        project: project.find((p) => p.id === prepared.projectId),
        directory,
      },
    });
    await workspaces("deleteProjectWorkspace", [workspace.id]);
    assert.equal((await stat(directory)).isDirectory(), true);
    assert.equal(await readFile(sentinel, "utf8"), contents);
    assert.ok(
      !(await page.evaluate(() => window.folderCrypto.getProjects())).some(
        (p) => p.id === prepared.projectId,
      ),
    );
    result.steps.push(
      "removing the attached workspace after conversion removes server records and preserves the actual repository and uncommitted files with its worker offline",
    );
    for (const request of requests.filter((r) => r.body))
      for (const plaintext of [
        root,
        directory,
        "Private attached workspace 🦀",
        "Private discovered repository 🌌",
        contents,
      ])
        assert.equal(
          request.body.includes(plaintext),
          false,
          "workspace/import requests retain endpoint encryption",
        );
    result.workspaceDiscoverySummary = {
      state: imported.job.state,
      attempt: imported.job.attempt,
      candidateState: imported.candidates[0].importState,
      candidateAttempt: imported.candidates[0].importAttempt,
      classification: imported.candidates[0].classification,
      sourceOwnership: "user",
      placement: "direct",
      workerFilesPreserved: true,
      convertedWithoutCatalogSeeding: true,
    };
    result.workspaceDiscovery = {
      workspace,
      imported,
      requests,
      revisionSequence: revisions,
      primaryWorktreeId: primary,
    };
  } finally {
    page.off("request", capture);
    await stopWorker();
  }
}
