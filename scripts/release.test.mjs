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
