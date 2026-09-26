import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { deployAppPlatform } from "./deploy-app-platform.mjs";
import { deployProduction } from "./deploy-production.mjs";

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

function hasSkipInstruction(message) {
  return /\[(?:skip ci|ci skip|no ci|skip actions|actions skip)\]|^skip-checks:\s*true\s*$/imu.test(
    message,
  );
}

function finishPromotion(root, commit, changed, skipped) {
  if (skipped) {
    // A separate push contains only this clean commit. Putting it in the first
    // push is insufficient when any ancestor in that push has a skip marker.
    const tree = git(root, ["rev-parse", `${commit}^{tree}`]).stdout;
    commit = git(root, [
      "commit-tree",
      tree,
      "-p",
      commit,
      "-m",
      "Publish native release artifacts",
    ]).stdout;
    git(root, ["push", "origin", `${commit}:refs/heads/release`], {
      inherit: true,
    });
    changed = true;
  }
  console.log(
    `Release is at ${commit.slice(0, 12)}; native artifacts build from this commit.`,
  );
  return { changed, commit };
}

export function promoteReleaseBranch({
  root = scriptRoot,
  verifyCompatibility = verifyInstallationCompatibility,
} = {}) {
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

  verifyCompatibility({ root });

  let promotionCommit = mainCommit;
  let previousRelease = null;
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
    previousRelease = releaseCommit;
    if (releaseCommit === mainCommit) {
      console.log(`release already points to ${mainCommit.slice(0, 12)}.`);
      return finishPromotion(
        root,
        mainCommit,
        false,
        hasSkipInstruction(
          git(root, ["log", "-1", "--format=%B", mainCommit]).stdout,
        ),
      );
    }
    const ancestry = git(
      root,
      ["merge-base", "--is-ancestor", releaseCommit, mainCommit],
      { allowFailure: true },
    );
    if (ancestry.status !== 0) {
      if (ancestry.status !== 1) {
        throw new Error("Could not inspect release ancestry.");
      }
      const mainTree = git(root, ["rev-parse", `${mainCommit}^{tree}`]).stdout;
      const releaseTree = git(root, [
        "rev-parse",
        `${releaseCommit}^{tree}`,
      ]).stdout;
      const containsMain = git(
        root,
        ["merge-base", "--is-ancestor", mainCommit, releaseCommit],
        { allowFailure: true },
      );
      if (containsMain.status > 1)
        throw new Error("Could not inspect main ancestry.");
      if (containsMain.status === 0 && mainTree === releaseTree) {
        console.log(
          `release already contains main at ${releaseCommit.slice(0, 12)}.`,
        );
        return finishPromotion(
          root,
          releaseCommit,
          false,
          hasSkipInstruction(
            git(root, ["log", "-1", "--format=%B", releaseCommit]).stdout,
          ),
        );
      }
      // Release is a promotion of main's exact snapshot, not an independent
      // source branch. Preserve both histories without merging release-only
      // content back into the product or rewriting the remote branch.
      const skipPromotion = hasSkipInstruction(
        git(root, ["log", "--format=%B", `${releaseCommit}..${mainCommit}`])
          .stdout,
      );
      promotionCommit = git(root, [
        "commit-tree",
        mainTree,
        "-p",
        releaseCommit,
        "-p",
        mainCommit,
        "-m",
        `Promote main ${mainCommit.slice(0, 12)} to release${skipPromotion ? " [skip ci]" : ""}`,
      ]).stdout;
    }
  } else if (remoteRelease.status !== 2) {
    throw new Error("Could not read origin/release; release was not promoted.");
  }

  const skipped = hasSkipInstruction(
    git(root, [
      "log",
      "--format=%B",
      previousRelease
        ? `${previousRelease}..${promotionCommit}`
        : promotionCommit,
    ]).stdout,
  );
  // Persist pending-trigger intent at the tip so retry can recover even when
  // the skip marker appeared only on an ancestor of a clean main commit.
  if (
    skipped &&
    !hasSkipInstruction(
      git(root, ["log", "-1", "--format=%B", promotionCommit]).stdout,
    )
  ) {
    promotionCommit = git(root, [
      "commit-tree",
      git(root, ["rev-parse", `${promotionCommit}^{tree}`]).stdout,
      "-p",
      promotionCommit,
      "-m",
      "Prepare native release [skip ci]",
    ]).stdout;
  }
  git(root, ["push", "origin", `${promotionCommit}:refs/heads/release`], {
    inherit: true,
  });
  console.log(
    `Promoted origin/release to ${promotionCommit.slice(0, 12)}. GitHub Actions will build and publish the native release artifacts.`,
  );
  return finishPromotion(root, promotionCommit, true, skipped);
}

export function verifyInstallationCompatibility({ root = scriptRoot } = {}) {
  for (const [script, label] of [
    [
      "scripts/installation-update-compatibility.mjs",
      "Installation compatibility",
    ],
    ["scripts/verify-workflow-removal.mjs", "Workflow removal"],
  ]) {
    const result = spawnSync(process.execPath, [script], {
      cwd: root,
      encoding: "utf8",
      stdio: "inherit",
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `${label} verification failed; release was not promoted.`,
      );
    }
  }
}

export async function releaseCantrip({
  root = scriptRoot,
  deploy = deployProduction,
  deployWeb = deployAppPlatform,
  verifyCompatibility = verifyInstallationCompatibility,
} = {}) {
  const promotion = promoteReleaseBranch({ root, verifyCompatibility });
  const appPlatformDeployment = await deployWeb({
    root,
    commit: promotion.commit,
    waitForActivation: false,
  });
  const deployment = await deploy({ root, commit: promotion.commit });
  return { appPlatformDeployment, deployment, promotion };
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  releaseCantrip().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
