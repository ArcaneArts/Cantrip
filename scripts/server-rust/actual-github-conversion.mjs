// Existing encrypted browser APIs and the complete worker convert a fresh
// managed folder by linking matching public GitHub history. No SQL fixtures,
// command substitutions, remote repository creation or push are involved.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveManagedFolderLocation } from "../../cantrip_worker/src/managed-folders.ts";
import { normalizeProjectSourcePath } from "../../cantrip_worker/src/project-source-path.ts";
import { eventually } from "./full-worker.mjs";

export async function actualGithubConversion({
  page,
  fixture,
  dataDirectory,
  workerId,
  startWorker,
  stopWorker,
  result,
}) {
  const remote = JSON.parse(
    execFileSync("gh", ["api", "repos/octocat/Hello-World"], {
      encoding: "utf8",
      timeout: 30000,
    }),
  );
  const repository = {
    repositoryId: String(remote.id),
    nameWithOwner: remote.full_name,
    url: remote.html_url,
  };
  const call = (operation, args = []) =>
    page.evaluate(
      async ({ operation, args }) =>
        (await import("/src/lib/api/project-replicas.ts"))[operation](...args),
      { operation, args },
    );
  const projects = () => page.evaluate(() => window.folderCrypto.getProjects());
  const wireProjects = () =>
    page.evaluate(() => window.folderWire.getProjectWireList());
  const requests = [];
  const capture = (request) => {
    if (/\/api\/projects\//.test(request.url()))
      requests.push({ url: request.url(), body: request.postData() });
  };
  page.on("request", capture);
  const git = (directory, ...args) =>
    execFileSync("git", ["-C", directory, ...args], {
      encoding: "utf8",
      timeout: 60000,
    }).trim();
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
    const project = await page.evaluate(
      (workerId) =>
        window.folderCrypto.createManagedFolderProject({
          name: "Private conversion acceptance 🌌",
          workerId,
        }),
      workerId,
    );
    await eventually(
      () => call("getProjectFolderSetupJob", [project.id]),
      (job) => assert.equal(job.state, "succeeded", JSON.stringify(job)),
    );
    const directory = normalizeProjectSourcePath(
      await realpath(
        deriveManagedFolderLocation(dataDirectory, project.id).target,
      ),
    );
    const relative = path.relative(
      await realpath(dataDirectory),
      await realpath(directory),
    );
    assert.ok(
      relative && !relative.startsWith("..") && !path.isAbsolute(relative),
      "checkout belongs to disposable worker data",
    );
    git(directory, "init", "--initial-branch=" + remote.default_branch);
    git(directory, "remote", "add", "origin", repository.url + ".git");
    git(directory, "fetch", "--depth=1", "origin", remote.default_branch);
    git(directory, "reset", "--hard", "FETCH_HEAD");
    const revision = git(directory, "rev-parse", "HEAD");
    const remoteBefore = git(
      directory,
      "ls-remote",
      "--heads",
      "origin",
      remote.default_branch,
    );
    const sentinel = path.join(directory, "private-uncommitted-conversion.txt");
    const contents = "Private uncommitted content survives conversion.\n";
    await writeFile(sentinel, contents);
    const before = (await projects()).find((p) => p.id === project.id);
    const wireBefore = (await wireProjects()).find((p) => p.id === project.id);
    assert.equal(before.source.sourceKind, "folder");
    assert.equal(before.source.ownershipKind, "cantrip");
    await page.evaluate((projectId) => {
      window.folderLive.retainScope({ kind: "project", projectId });
      window.folderLive.start();
    }, project.id);
    await eventually(
      () => page.evaluate(() => window.folderLive.snapshot()),
      (snapshot) => {
        assert.equal(snapshot.status, "live");
        assert.equal(snapshot.activeScopeCount, snapshot.desiredScopeCount);
      },
    );
    const preflight = await call("preflightProjectGithubConversion", [
      project.id,
      { repository },
    ]);
    assert.equal(preflight.status, "ready", JSON.stringify(preflight));
    assert.equal(preflight.remoteAction, "link");
    assert.equal(preflight.requiresInitialCommit, false);
    assert.equal(preflight.localState, "committed");
    assert.equal(preflight.dirty, true);
    assert.equal(preflight.head, revision);
    assert.equal(preflight.projectSourceId, before.source.id);
    assert.equal(preflight.workerId, workerId);
    result.steps.push(
      "existing encrypted browser preflights a real managed folder with matching public GitHub history and selects link",
    );
    const admitted = await call("startProjectGithubConversion", [
      project.id,
      {
        repository,
        projectSourceId: preflight.projectSourceId,
        workerId,
        confirmationToken: preflight.confirmationToken,
        initialCommit: null,
      },
    ]);
    const completed = await eventually(
      () => call("getProjectGithubConversion", [project.id]),
      (job) => {
        assert.equal(job?.state, "succeeded", JSON.stringify(job));
        assert.equal(job.attempt, 1);
        assert.equal(job.stateRevision, 3);
        assert.equal(job.error, null);
      },
      120000,
    );
    assert.equal(completed.id, admitted.id);
    assert.deepEqual(completed.repository, repository);
    const converted = await eventually(projects, (projects) => {
      const p = projects.find((p) => p.id === project.id);
      assert.equal(p?.originKind, "github");
      assert.equal(p.source.sourceKind, "git");
    });
    const after = converted.find((p) => p.id === project.id);
    const wireAfter = (await wireProjects()).find((p) => p.id === project.id);
    assert.equal(after.name, before.name);
    assert.equal(after.source.id, before.source.id);
    assert.equal(after.source.ownershipKind, before.source.ownershipKind);
    assert.equal(after.source.path, directory);
    assert.equal(after.replicas[0].head, revision);
    assert.ok(wireBefore.replicas[0].primaryWorktreeId);
    assert.equal(
      wireAfter.replicas[0].primaryWorktreeId,
      wireBefore.replicas[0].primaryWorktreeId,
    );
    assert.deepEqual(wireAfter.nameProtection, wireBefore.nameProtection);
    assert.equal(after.github.nameWithOwner, repository.nameWithOwner);
    assert.equal(await readFile(sentinel, "utf8"), contents);
    assert.equal(git(directory, "rev-parse", "HEAD"), revision);
    assert.equal(
      git(directory, "ls-remote", "--heads", "origin", remote.default_branch),
      remoteBefore,
    );
    const events = await eventually(
      () =>
        page.evaluate(
          (id) =>
            window.folderEvents.filter(
              (e) =>
                e.resource === "project-github-conversion-job" &&
                e.entityId === id,
            ),
          completed.id,
        ),
      (events) =>
        assert.deepEqual(
          events.map((e) => e.revision),
          [1, 3],
        ),
    );
    const conversionRequests = requests.filter(
      (r) => /\/github-conversion(?:\/preflight)?$/.test(r.url) && r.body,
    );
    assert.equal(conversionRequests.length, 2);
    for (const request of conversionRequests) {
      const body = JSON.parse(request.body);
      for (const key of ["repositoryId", "nameWithOwner", "url"])
        assert.match(body.repository[key], /^ctrr_[A-Za-z0-9_-]{43}$/);
      for (const value of [
        repository.nameWithOwner,
        repository.url,
        directory,
        contents,
      ])
        assert.equal(request.body.includes(value), false);
    }
    result.steps.push(
      "full worker links GitHub without changing the remote, retains uncommitted bytes and project/source/Primary identities, and publishes ordered conversion completion",
    );
    await stopWorker();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    await startWorker();
    const retained = await eventually(
      () => call("getProjectGithubConversion", [project.id]),
      (job) => assert.deepEqual(job, completed),
    );
    const reopened = await eventually(projects, (projects) =>
      assert.equal(
        projects.find((p) => p.id === project.id)?.source.path,
        directory,
      ),
    );
    const retainedProject = reopened.find((p) => p.id === project.id);
    assert.equal(retainedProject.source.id, before.source.id);
    assert.equal(
      retainedProject.github.nameWithOwner,
      repository.nameWithOwner,
    );
    assert.equal(await readFile(sentinel, "utf8"), contents);
    result.steps.push(
      "server and full worker restart retain the converted GitHub job, encrypted metadata and existing local checkout",
    );
    result.githubConversionSummary = {
      repository,
      state: retained.state,
      attempt: retained.attempt,
      revision: retained.stateRevision,
      eventRevisions: events.map((e) => e.revision),
      originKind: retainedProject.originKind,
      sourceKind: retainedProject.source.sourceKind,
      ownershipKind: retainedProject.source.ownershipKind,
      remoteAction: preflight.remoteAction,
      retainedDirtyBytes: true,
    };
    result.githubConversion = {
      before,
      after,
      retained,
      wireBefore,
      wireAfter,
      requests: conversionRequests,
    };
  } finally {
    page.off("request", capture);
    await stopWorker();
  }
}
