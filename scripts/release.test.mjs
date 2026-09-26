import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { promoteReleaseBranch, releaseCantrip } from "./release.mjs";

function git(root, ...arguments_) {
  return execFileSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

async function repositoryFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-release-test-"));
  const remote = path.join(root, "remote.git");
  const repository = path.join(root, "repository");
  git(root, "init", "--bare", remote);
  git(root, "init", "--initial-branch=main", repository);
  git(repository, "config", "user.name", "Cantrip Test");
  git(repository, "config", "user.email", "cantrip@example.test");
  git(repository, "remote", "add", "origin", remote);
  await writeFile(path.join(repository, "state.txt"), "one\n");
  git(repository, "add", "state.txt");
  git(repository, "commit", "-m", "initial");
  git(repository, "push", "-u", "origin", "main");
  return { remote, repository, root };
}

test("promotes release only through fast-forward updates from synchronized main", async () => {
  const fixture = await repositoryFixture();
  try {
    const first = promoteReleaseBranch({
      root: fixture.repository,
      verifyCompatibility: () => undefined,
    });
    assert.equal(first.changed, true);
    assert.equal(
      git(fixture.remote, "rev-parse", "refs/heads/release"),
      git(fixture.repository, "rev-parse", "refs/heads/main"),
    );
    assert.equal(
      promoteReleaseBranch({
        root: fixture.repository,
        verifyCompatibility: () => undefined,
      }).changed,
      false,
    );

    await writeFile(path.join(fixture.repository, "state.txt"), "two\n");
    git(fixture.repository, "add", "state.txt");
    git(fixture.repository, "commit", "-m", "next");
    assert.throws(
      () =>
        promoteReleaseBranch({
          root: fixture.repository,
          verifyCompatibility: () => undefined,
        }),
      /Push main before releasing/u,
    );
    git(fixture.repository, "push", "origin", "main");
    assert.equal(
      promoteReleaseBranch({
        root: fixture.repository,
        verifyCompatibility: () => undefined,
      }).changed,
      true,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("refuses to promote from a non-main branch", async () => {
  const fixture = await repositoryFixture();
  try {
    git(fixture.repository, "switch", "-c", "topic");
    assert.throws(
      () =>
        promoteReleaseBranch({
          root: fixture.repository,
          verifyCompatibility: () => undefined,
        }),
      /must run from main/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("refuses to promote when installation compatibility verification fails", async () => {
  const fixture = await repositoryFixture();
  try {
    assert.throws(
      () =>
        promoteReleaseBranch({
          root: fixture.repository,
          verifyCompatibility: () => {
            throw new Error("compatibility contract changed");
          },
        }),
      /compatibility contract changed/u,
    );
    assert.throws(
      () => git(fixture.remote, "rev-parse", "refs/heads/release"),
      /unknown revision|ambiguous argument/iu,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("deploys the exact commit promoted to release", async () => {
  const fixture = await repositoryFixture();
  try {
    let deployed;
    let webDeployed;
    const calls = [];
    const result = await releaseCantrip({
      root: fixture.repository,
      deploy: async (options) => {
        calls.push("server");
        deployed = options;
        return { commit: options.commit };
      },
      deployWeb: async (options) => {
        calls.push("web");
        webDeployed = options;
        return { commit: options.commit };
      },
      verifyCompatibility: () => undefined,
    });
    assert.deepEqual(calls, ["web", "server"]);
    assert.equal(deployed.root, fixture.repository);
    assert.equal(webDeployed.root, fixture.repository);
    assert.equal(webDeployed.waitForActivation, false);
    assert.equal(
      deployed.commit,
      git(fixture.repository, "rev-parse", "refs/heads/main"),
    );
    assert.equal(webDeployed.commit, deployed.commit);
    assert.equal(result.appPlatformDeployment.commit, deployed.commit);
    assert.equal(result.deployment.commit, deployed.commit);
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("reconciles release-only history with main's exact tree and deploys the promoted SHA", async () => {
  const fixture = await repositoryFixture();
  try {
    git(fixture.repository, "switch", "-c", "release");
    await writeFile(
      path.join(fixture.repository, "release-only.txt"),
      "old release content\n",
    );
    git(fixture.repository, "add", ".");
    git(fixture.repository, "commit", "-m", "release-only history");
    const oldRelease = git(fixture.repository, "rev-parse", "HEAD");
    git(fixture.repository, "push", "origin", "release");
    git(fixture.repository, "switch", "main");
    await writeFile(path.join(fixture.repository, "state.txt"), "new main\n");
    git(fixture.repository, "commit", "-am", "main changes");
    git(fixture.repository, "push", "origin", "main");
    const main = git(fixture.repository, "rev-parse", "HEAD");
    const deployed = [];
    const result = await releaseCantrip({
      root: fixture.repository,
      verifyCompatibility: () => undefined,
      deploy: async ({ commit }) => {
        deployed.push(commit);
      },
      deployWeb: async ({ commit }) => {
        deployed.push(commit);
      },
    });
    const promoted = git(fixture.remote, "rev-parse", "release");
    assert.notEqual(promoted, main);
    assert.deepEqual(deployed, [promoted, promoted]);
    assert.equal(result.promotion.commit, promoted);
    assert.equal(
      git(fixture.repository, "rev-parse", `${promoted}^{tree}`),
      git(fixture.repository, "rev-parse", `${main}^{tree}`),
    );
    git(
      fixture.repository,
      "merge-base",
      "--is-ancestor",
      oldRelease,
      promoted,
    );
    git(fixture.repository, "merge-base", "--is-ancestor", main, promoted);
    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), main);
    assert.equal(git(fixture.repository, "status", "--porcelain"), "");
    assert.deepEqual(
      promoteReleaseBranch({
        root: fixture.repository,
        verifyCompatibility: () => undefined,
      }),
      { changed: false, commit: promoted },
    );
    await writeFile(path.join(fixture.repository, "state.txt"), "next main\n");
    git(fixture.repository, "commit", "-am", "another release");
    git(fixture.repository, "push", "origin", "main");
    const next = promoteReleaseBranch({
      root: fixture.repository,
      verifyCompatibility: () => undefined,
    });
    assert.equal(next.changed, true);
    git(
      fixture.repository,
      "merge-base",
      "--is-ancestor",
      promoted,
      next.commit,
    );
    assert.equal(
      git(fixture.repository, "rev-parse", `${next.commit}^{tree}`),
      git(fixture.repository, "rev-parse", "main^{tree}"),
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("pushes skip-marked history separately from a clean release trigger and retries idempotently", async () => {
  const fixture = await repositoryFixture();
  try {
    git(
      fixture.repository,
      "commit",
      "--allow-empty",
      "-m",
      "implementation [skip ci]",
    );
    git(
      fixture.repository,
      "commit",
      "--allow-empty",
      "-m",
      "clean head above skipped ancestor",
    );
    git(fixture.repository, "push", "origin", "main");
    const updates = path.join(fixture.root, "updates");
    const { chmod, readFile } = await import("node:fs/promises");
    const hook = path.join(fixture.remote, "hooks", "post-receive");
    await writeFile(hook, `#!/bin/sh\ncat >> '${updates}'\n`);
    await chmod(hook, 0o755);
    const promote = () =>
      promoteReleaseBranch({
        root: fixture.repository,
        verifyCompatibility: () => undefined,
      });
    const result = promote();
    const pushes = (await readFile(updates, "utf8"))
      .trim()
      .split("\n")
      .map((line) => line.split(" "));
    assert.equal(pushes.length, 2);
    assert.equal(pushes[1][0], pushes[0][1]);
    assert.equal(pushes[1][1], result.commit);
    assert.equal(
      git(
        fixture.repository,
        "rev-list",
        "--count",
        `${pushes[1][0]}..${result.commit}`,
      ),
      "1",
    );
    assert.equal(
      git(fixture.repository, "log", "-1", "--format=%B", result.commit),
      "Publish native release artifacts",
    );
    assert.equal(
      git(fixture.repository, "rev-parse", `${result.commit}^{tree}`),
      git(fixture.repository, "rev-parse", "main^{tree}"),
    );
    assert.deepEqual(promote(), { changed: false, commit: result.commit });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("recovers when the trigger push fails after divergent skipped history was promoted", async () => {
  const fixture = await repositoryFixture();
  try {
    git(fixture.repository, "switch", "-c", "release");
    git(
      fixture.repository,
      "commit",
      "--allow-empty",
      "-m",
      "previous release trigger",
    );
    git(fixture.repository, "push", "origin", "release");
    git(fixture.repository, "switch", "main");
    git(
      fixture.repository,
      "commit",
      "--allow-empty",
      "-m",
      "next main [skip ci]",
    );
    git(fixture.repository, "push", "origin", "main");
    const { chmod } = await import("node:fs/promises");
    const hook = path.join(fixture.remote, "hooks", "pre-receive");
    await writeFile(
      hook,
      '#!/bin/sh\nread old new ref\nif test "$(git log -1 --format=%s "$new")" = "Publish native release artifacts"; then exit 1; fi\n',
    );
    await chmod(hook, 0o755);
    const promote = () =>
      promoteReleaseBranch({
        root: fixture.repository,
        verifyCompatibility: () => undefined,
      });
    assert.throws(promote, /git push/);
    const staged = git(fixture.remote, "rev-parse", "release");
    await rm(hook);
    const completed = promote();
    assert.equal(completed.changed, true);
    assert.equal(
      git(fixture.repository, "rev-parse", `${completed.commit}^`),
      staged,
    );
    assert.deepEqual(promote(), { changed: false, commit: completed.commit });
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});
