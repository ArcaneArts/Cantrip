import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const scriptRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function git(root, arguments_, options = {}) {
  const result = spawnSync("git", arguments_, {
    cwd: root,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : "pipe",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    const detail = (result.stderr || result.stdout || "").trim();
    throw new Error(
      `git ${arguments_.join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return {
    status: result.status ?? 1,
    stdout: (result.stdout ?? "").trim(),
  };
}

export function promoteReleaseBranch({ root = scriptRoot } = {}) {
  const topLevel = realpathSync(
    git(root, ["rev-parse", "--show-toplevel"]).stdout,
  );
  if (topLevel !== realpathSync(root)) {
    throw new Error(
      `Release must run from the Cantrip repository root: ${root}`,
    );
  }
  const branch = git(root, ["branch", "--show-current"]).stdout;
  if (branch !== "main") {
    throw new Error(
      `pnpm release must run from main; the current branch is ${branch || "detached"}.`,
    );
  }
  if (git(root, ["status", "--porcelain"]).stdout) {
    throw new Error("pnpm release requires a clean main working tree.");
  }

  git(root, ["pull", "--ff-only", "origin", "main"], { inherit: true });
  const mainCommit = git(root, ["rev-parse", "refs/heads/main"]).stdout;
  const remoteMainCommit = git(root, [
    "rev-parse",
    "refs/remotes/origin/main",
  ]).stdout;
  if (mainCommit !== remoteMainCommit) {
    throw new Error(
      "Local main has commits that are not on origin/main. Push main before releasing.",
    );
  }

  const remoteRelease = git(
    root,
    ["ls-remote", "--exit-code", "--heads", "origin", "release"],
    { allowFailure: true },
  );
  if (remoteRelease.status === 0) {
    git(root, [
      "fetch",
      "origin",
      "refs/heads/release:refs/remotes/origin/release",
    ]);
    const releaseCommit = git(root, [
      "rev-parse",
      "refs/remotes/origin/release",
    ]).stdout;
    if (releaseCommit === mainCommit) {
      console.log(`release already points to ${mainCommit.slice(0, 12)}.`);
      return { changed: false, commit: mainCommit };
    }
    const ancestry = git(
      root,
      ["merge-base", "--is-ancestor", releaseCommit, mainCommit],
      { allowFailure: true },
    );
    if (ancestry.status !== 0) {
      throw new Error(
        "origin/release cannot fast-forward to main. Reconcile the release branch manually.",
      );
    }
  }

  git(root, ["push", "origin", "refs/heads/main:refs/heads/release"], {
    inherit: true,
  });
  console.log(
    `Promoted origin/release to ${mainCommit.slice(0, 12)}. GitHub Actions will build and publish the native release artifacts.`,
  );
  return { changed: true, commit: mainCommit };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) promoteReleaseBranch();
