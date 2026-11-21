// Existing encrypted browser APIs and the complete worker convert a fresh
// managed folder by linking matching public GitHub history. No SQL fixtures,
// command substitutions or remote writes are involved in the link case.
// Initial commit and push use a disposable local bare remote.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { deriveManagedFolderLocation } from "../../tests/reference-node-worker/src/managed-folders.ts";
import { normalizeProjectSourcePath } from "../../tests/reference-node-worker/src/project-source-path.ts";
import { eventually } from "./full-worker.mjs";

async function initialPushFixture(dataDirectory) {
  const fixture = path.join(dataDirectory, "github-initial-push");
  const bin = path.join(fixture, "bin");
  const bare = path.join(fixture, "remote.git");
  await mkdir(bin, { recursive: true });
  const repository = {
    id: 42,
    full_name: "cantrip-qa-fixture/initial-push",
    html_url: "https://github.com/cantrip-qa-fixture/initial-push",
    default_branch: "main",
  };
  const environment = {
    PATH: [bin, process.env.PATH].filter(Boolean).join(path.delimiter),
    CANTRIP_QA_GITHUB_BARE: bare,
    GIT_ALLOW_PROTOCOL: "file",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${bare}.insteadOf`,
    GIT_CONFIG_VALUE_0: `${repository.html_url}.git`,
    GIT_AUTHOR_NAME: "Cantrip QA",
    GIT_AUTHOR_EMAIL: "cantrip@example.test",
    GIT_COMMITTER_NAME: "Cantrip QA",
    GIT_COMMITTER_EMAIL: "cantrip@example.test",
  };
  const git = (...args) =>
    execFileSync("git", args, {
      encoding: "utf8",
      env: { ...process.env, ...environment },
      timeout: 60000,
    });
  git("init", "--bare", "--initial-branch=main", bare);
  await writeFile(
    path.join(bin, "gh"),
    `#!/bin/sh
case "$1:$2" in
  api:repos/${repository.full_name})
    printf '%s\n' '${JSON.stringify(repository)}'
    ;;
  api:graphql)
    refs=$(git --git-dir "$CANTRIP_QA_GITHUB_BARE" for-each-ref) || exit 1
    if [ -z "$refs" ]; then
      printf '%s\n' '{"data":{"repository":{"isEmpty":true}}}'
    else
      printf '%s\n' '{"data":{"repository":{"isEmpty":false}}}'
    fi
    ;;
  auth:git-credential) ;;
  *) exit 1 ;;
esac
`,
    { mode: 0o700 },
  );
  return { repository, environment, bare, git };
}

export async function actualGithubConversion({
  page,
  fixture,
  dataDirectory,
  workerId,
  startWorker,
  stopWorker,
  result,
  externalSource,
  initialPush = false,
}) {
  const push = initialPush ? await initialPushFixture(dataDirectory) : null;
  const remote =
    push?.repository ??
    JSON.parse(
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
  const startConversionWorker = () =>
    push
      ? startWorker(undefined, { environment: push.environment })
      : startWorker();
  try {
    if (push) await stopWorker();
    await startConversionWorker();
    await eventually(
      () => page.evaluate(() => window.folderWorkers.getWorkers()),
      (workers) =>
        assert.equal(
          workers.find((w) => w.workerId === workerId)?.online,
          true,
        ),
    );
    const project =
      externalSource?.project ??
      (await page.evaluate(
        (workerId) =>
          window.folderCrypto.createManagedFolderProject({
            name: "Private conversion acceptance 🌌",
            workerId,
          }),
        workerId,
      ));
    if (!externalSource)
      await eventually(
        () => call("getProjectFolderSetupJob", [project.id]),
        (job) => assert.equal(job.state, "succeeded", JSON.stringify(job)),
      );
    const directory =
      externalSource?.directory ??
      normalizeProjectSourcePath(
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
    if (!push) {
      if (!externalSource)
        git(directory, "init", "--initial-branch=" + remote.default_branch);
      git(directory, "remote", "add", "origin", repository.url + ".git");
      if (!externalSource) {
        git(directory, "fetch", "--depth=1", "origin", remote.default_branch);
        git(directory, "reset", "--hard", "FETCH_HEAD");
      }
    }
    const revision = push ? null : git(directory, "rev-parse", "HEAD");
    const remoteHead = () =>
      push
        ? push
            .git("--git-dir", push.bare, "rev-parse", "refs/heads/main")
            .trim()
        : git(
            directory,
            "ls-remote",
            "--heads",
            "origin",
            remote.default_branch,
          );
    const remoteBefore = push ? null : remoteHead();
    if (push)
      assert.equal(push.git("--git-dir", push.bare, "for-each-ref"), "");
    const sentinel = path.join(directory, "private-uncommitted-conversion.txt");
    const contents = "Private uncommitted content survives conversion.\n";
    await writeFile(sentinel, contents);
    const before = (await projects()).find((p) => p.id === project.id);
    const wireBefore = (await wireProjects()).find((p) => p.id === project.id);
    assert.equal(before.source.sourceKind, externalSource ? "git" : "folder");
    assert.equal(
      before.source.ownershipKind,
      externalSource ? "user" : "cantrip",
    );
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
      {
        repository,
        ...(externalSource
          ? { projectSourceId: before.source.id, workerId }
          : {}),
      },
    ]);
    assert.equal(preflight.status, "ready", JSON.stringify(preflight));
    assert.equal(preflight.remoteAction, push ? "push" : "link");
    assert.equal(preflight.requiresInitialCommit, Boolean(push));
    assert.equal(preflight.localState, push ? "not-initialized" : "committed");
    assert.equal(preflight.dirty, !push);
    assert.equal(preflight.head, revision);
    assert.equal(preflight.projectSourceId, before.source.id);
    assert.equal(preflight.workerId, workerId);
    result.steps.push(
      push
        ? "existing encrypted browser preflights a real managed folder and requests approval for its initial commit"
        : externalSource
          ? "existing encrypted browser preflights a discovery-imported user-owned checkout against public GitHub history and selects link"
          : "existing encrypted browser preflights a real managed folder with matching public GitHub history and selects link",
    );
    const initialCommit = push
      ? { message: "Cantrip QA initial commit" }
      : null;
    const admitted = await call("startProjectGithubConversion", [
      project.id,
      {
        repository,
        projectSourceId: preflight.projectSourceId,
        workerId,
        confirmationToken: preflight.confirmationToken,
        initialCommit,
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
    const convertedHead = git(directory, "rev-parse", "HEAD");
    assert.equal(after.replicas[0].head, convertedHead);
    assert.ok(wireBefore.replicas[0].primaryWorktreeId);
    assert.equal(
      wireAfter.replicas[0].primaryWorktreeId,
      wireBefore.replicas[0].primaryWorktreeId,
    );
    assert.deepEqual(wireAfter.nameProtection, wireBefore.nameProtection);
    assert.equal(after.github.nameWithOwner, repository.nameWithOwner);
    assert.equal(await readFile(sentinel, "utf8"), contents);
    if (push) {
      assert.equal(remoteHead(), convertedHead);
      assert.equal(git(directory, "rev-list", "--count", "HEAD"), "1");
      assert.equal(
        git(directory, "log", "-1", "--format=%s"),
        initialCommit.message,
      );
      assert.equal(
        push.git(
          "--git-dir",
          push.bare,
          "show",
          `main:${path.basename(sentinel)}`,
        ),
        contents,
      );
    } else {
      assert.equal(convertedHead, revision);
      assert.equal(remoteHead(), remoteBefore);
    }
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
      push
        ? "full worker creates one approved commit, pushes it to the owned local remote, preserves project/source/Primary identities, and publishes ordered completion"
        : "full worker links GitHub without changing the remote, retains uncommitted bytes and project/source/Primary identities, and publishes ordered conversion completion",
    );
    await stopWorker();
    const port = Number(new URL(fixture.server.origin).port);
    await fixture.close();
    await fixture.start({ port });
    await startConversionWorker();
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
    if (push) {
      assert.equal(remoteHead(), convertedHead);
      assert.equal(git(directory, "rev-list", "--count", "HEAD"), "1");
    }
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
      ...(push ? { pushedInitialCommit: true } : { retainedDirtyBytes: true }),
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
