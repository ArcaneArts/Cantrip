import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { promoteReleaseBranch, releaseCantrip } from "./release.mjs";
import {
  productionServerBuildArguments,
  withProductionSource,
} from "./deploy-production.mjs";

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
      deploy: async (options) =>
        withProductionSource(
          options,
          async ({ root, commit, versionPatch }) => {
            deployed.push(commit);
            assert.equal(
              await readFile(path.join(root, "state.txt"), "utf8"),
              "new main\n",
            );
            await assert.rejects(
              readFile(path.join(root, "release-only.txt")),
              {
                code: "ENOENT",
              },
            );
            assert.equal(
              versionPatch,
              git(root, "rev-list", "--count", commit),
            );
            assert.ok(
              productionServerBuildArguments(
                { platform: "linux/amd64" },
                "/tmp/server-output",
                versionPatch,
              ).includes(`CANTRIP_VERSION_PATCH=${versionPatch}`),
            );
            return { commit };
          },
        ),
      deployWeb: async ({ commit }) => {
        deployed.push(commit);
      },
    });
    const promoted = git(fixture.remote, "rev-parse", "release");
    assert.notEqual(promoted, main);
    assert.deepEqual(deployed, [promoted, promoted]);
    assert.equal(result.promotion.commit, promoted);
    assert.equal(result.deployment.commit, promoted);
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
    await withProductionSource(
      { root: fixture.repository, commit: result.commit },
      async ({ root, commit, versionPatch }) => {
        assert.equal(commit, result.commit);
        assert.equal(
          await readFile(path.join(root, "state.txt"), "utf8"),
          "one\n",
        );
        assert.equal(
          versionPatch,
          git(fixture.repository, "rev-list", "--count", result.commit),
        );
        assert.notEqual(
          versionPatch,
          git(fixture.repository, "rev-list", "--count", "main"),
        );
      },
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("builds the promoted snapshot even if local main advances and becomes dirty during web deployment", async () => {
  const fixture = await repositoryFixture();
  try {
    const main = git(fixture.repository, "rev-parse", "HEAD");
    let sourceRoot;
    const result = await releaseCantrip({
      root: fixture.repository,
      verifyCompatibility: () => undefined,
      deployWeb: async () => {
        await writeFile(
          path.join(fixture.repository, "state.txt"),
          "future main\n",
        );
        git(fixture.repository, "commit", "-am", "next development commit");
        await writeFile(
          path.join(fixture.repository, "state.txt"),
          "uncommitted draft\n",
        );
      },
      deploy: (options) =>
        withProductionSource(options, async ({ root, commit }) => {
          sourceRoot = root;
          assert.equal(commit, main);
          assert.equal(
            await readFile(path.join(root, "state.txt"), "utf8"),
            "one\n",
          );
          return { commit };
        }),
    });
    assert.equal(result.deployment.commit, main);
    assert.equal(
      await readFile(path.join(fixture.repository, "state.txt"), "utf8"),
      "uncommitted draft\n",
    );
    assert.match(
      git(fixture.repository, "status", "--porcelain"),
      /state\.txt/u,
    );
    await assert.rejects(readFile(path.join(sourceRoot, "state.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      git(fixture.repository, "worktree", "list", "--porcelain").includes(
        sourceRoot,
      ),
      false,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("standalone deployment fetches the remote release snapshot rather than local main", async () => {
  const fixture = await repositoryFixture();
  try {
    const release = promoteReleaseBranch({
      root: fixture.repository,
      verifyCompatibility: () => undefined,
    }).commit;
    git(fixture.repository, "switch", "-c", "development");
    await writeFile(
      path.join(fixture.repository, "state.txt"),
      "not released\n",
    );
    git(fixture.repository, "commit", "-am", "local development");
    const head = git(fixture.repository, "rev-parse", "HEAD");
    await withProductionSource(
      { root: fixture.repository },
      async ({ root, commit }) => {
        assert.equal(commit, release);
        assert.equal(
          await readFile(path.join(root, "state.txt"), "utf8"),
          "one\n",
        );
      },
    );
    assert.equal(git(fixture.repository, "rev-parse", "HEAD"), head);
    assert.equal(
      await readFile(path.join(fixture.repository, "state.txt"), "utf8"),
      "not released\n",
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

test("cleans up the release checkout and propagates an actual build failure", async () => {
  const fixture = await repositoryFixture();
  try {
    const commit = git(fixture.repository, "rev-parse", "HEAD");
    const failure = new Error("Docker build failed");
    let sourceRoot;
    await assert.rejects(
      withProductionSource(
        { root: fixture.repository, commit },
        async ({ root }) => {
          sourceRoot = root;
          await writeFile(
            path.join(root, "build-output.txt"),
            "temporary output\n",
          );
          throw failure;
        },
      ),
      (error) => error === failure,
    );
    await assert.rejects(readFile(path.join(sourceRoot, "state.txt")), {
      code: "ENOENT",
    });
    assert.equal(
      git(fixture.repository, "worktree", "list", "--porcelain").includes(
        sourceRoot,
      ),
      false,
    );
    assert.equal(git(fixture.repository, "status", "--porcelain"), "");
    await assert.rejects(
      withProductionSource(
        { root: fixture.repository, commit: "missing-release-commit" },
        () => {
          assert.fail("a missing commit cannot be built");
        },
      ),
      /invalid reference/u,
    );
  } finally {
    await rm(fixture.root, { force: true, recursive: true });
  }
});

for (const fails of [false, true]) {
  test(`a cleanup warning does not replace the ${fails ? "failed" : "successful"} deployment result`, async (context) => {
    const fixture = await repositoryFixture();
    let sourceRoot;
    const warnings = [];
    context.mock.method(console, "warn", (message) => warnings.push(message));
    try {
      const commit = git(fixture.repository, "rev-parse", "HEAD");
      const failure = new Error("actual SSH failure");
      const result = { commit };
      const deployment = withProductionSource(
        { root: fixture.repository, commit },
        async ({ root }) => {
          sourceRoot = root;
          git(fixture.repository, "worktree", "lock", root);
          if (fails) throw failure;
          return result;
        },
      );
      if (fails) await assert.rejects(deployment, (error) => error === failure);
      else assert.equal(await deployment, result);
      assert.equal(warnings.length, 1);
      assert.ok(warnings[0].includes(sourceRoot));
    } finally {
      if (sourceRoot) {
        git(fixture.repository, "worktree", "unlock", sourceRoot);
        git(fixture.repository, "worktree", "remove", "--force", sourceRoot);
        await rm(path.dirname(sourceRoot), { recursive: true, force: true });
      }
      await rm(fixture.root, { force: true, recursive: true });
    }
  });
}

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
