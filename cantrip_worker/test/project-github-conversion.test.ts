import { execFile } from "node:child_process";
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import { ManagedFolderManager } from "../src/managed-folders.js";
import { ProjectGithubConverter } from "../src/project-github-conversion.js";

const execFileAsync = promisify(execFile);
const directories: string[] = [];
const originalPath = process.env.PATH;
const projectId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb338";
const jobId = "019fe8aa-a7a3-7404-8a96-d3be7f0fb339";
const repository = {
  repositoryId: "42",
  nameWithOwner: "ArcaneArts/Scratch",
  url: "https://github.com/ArcaneArts/Scratch",
};

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.CANTRIP_TEST_BARE;
  delete process.env.GIT_AUTHOR_EMAIL;
  delete process.env.GIT_AUTHOR_NAME;
  delete process.env.GIT_COMMITTER_EMAIL;
  delete process.env.GIT_COMMITTER_NAME;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const dataDirectory = await mkdtemp(
    path.join(tmpdir(), "cantrip-github-conversion-test-"),
  );
  directories.push(dataDirectory);
  const remoteRoot = path.join(dataDirectory, "remotes");
  const bare = path.join(remoteRoot, "ArcaneArts", "Scratch.git");
  const binaryDirectory = path.join(dataDirectory, "bin");
  await mkdir(path.dirname(bare), { recursive: true });
  await mkdir(binaryDirectory);
  await execFileAsync("git", ["init", "--bare", bare]);
  const gh = path.join(binaryDirectory, "gh");
  await writeFile(
    gh,
    `#!/bin/sh
if [ "$1" = "api" ] && [ "$2" = "repos/ArcaneArts/Scratch" ]; then
  printf '%s\\n' '{"id":42,"full_name":"ArcaneArts/Scratch","html_url":"https://github.com/ArcaneArts/Scratch","default_branch":"main"}'
  exit 0
fi
if [ "$1" = "api" ] && [ "$2" = "graphql" ]; then
  if git --git-dir "$CANTRIP_TEST_BARE" show-ref --quiet; then
    printf '%s\\n' '{"data":{"repository":{"isEmpty":false}}}'
  else
    printf '%s\\n' '{"data":{"repository":{"isEmpty":true}}}'
  fi
  exit 0
fi
if [ "$1" = "auth" ] && [ "$2" = "git-credential" ]; then
  exit 0
fi
printf '%s\\n' "unexpected gh command: $*" >&2
exit 1
`,
    { mode: 0o700 },
  );
  await chmod(gh, 0o700);
  process.env.PATH = `${binaryDirectory}${path.delimiter}${originalPath}`;
  process.env.CANTRIP_TEST_BARE = bare;
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = `url.${remoteRoot}${path.sep}.insteadOf`;
  process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
  process.env.GIT_AUTHOR_NAME = "Cantrip Test";
  process.env.GIT_AUTHOR_EMAIL = "cantrip@example.test";
  process.env.GIT_COMMITTER_NAME = "Cantrip Test";
  process.env.GIT_COMMITTER_EMAIL = "cantrip@example.test";
  const folders = new ManagedFolderManager(dataDirectory);
  const materialized = await folders.materialize({
    attempt: 1,
    jobId,
    projectId,
  });
  return {
    bare,
    converter: new ProjectGithubConverter(folders),
    materialized,
  };
}

describe("project GitHub conversion", () => {
  it("creates an explicitly approved initial commit, pushes, and replays", async () => {
    const test = await fixture();
    await writeFile(
      path.join(test.materialized.path, "README.md"),
      "scratch\n",
    );
    const preflight = await test.converter.preflight({ projectId, repository });
    expect(preflight).toMatchObject({
      status: "ready",
      localState: "not-initialized",
      requiresInitialCommit: true,
    });
    if (preflight.status !== "ready") throw new Error("preflight failed");

    const first = await test.converter.execute({
      attempt: 1,
      confirmationToken: preflight.confirmationToken,
      initialCommit: { message: "Initial commit" },
      jobId,
      projectId,
      repository,
    });
    if (first.status === "blocked") {
      throw new Error(JSON.stringify(first.error));
    }
    expect(first).toMatchObject({
      status: "ready",
      branch: "main",
      path: test.materialized.path,
    });
    expect(
      (
        await execFileAsync("git", [
          "--git-dir",
          test.bare,
          "show",
          "main:README.md",
        ])
      ).stdout,
    ).toBe("scratch\n");

    const replay = await test.converter.execute({
      attempt: 2,
      confirmationToken: preflight.confirmationToken,
      initialCommit: { message: "Initial commit" },
      jobId,
      projectId,
      repository,
    });
    if (replay.status === "blocked") {
      throw new Error(JSON.stringify(replay.error));
    }
    expect(replay).toMatchObject({
      status: "ready",
      branch: "main",
    });
  });

  it("refuses a GitHub repository that already has history", async () => {
    const test = await fixture();
    const seed = path.join(path.dirname(test.bare), "seed");
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "existing\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", ["-C", seed, "commit", "-m", "Existing"]);
    await execFileAsync("git", ["-C", seed, "push", test.bare, "main"]);

    await expect(
      test.converter.preflight({ projectId, repository }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "repository-not-empty", retryable: false },
    });
  });

  it("refuses a manually initialized repository bound elsewhere", async () => {
    const test = await fixture();
    await execFileAsync("git", [
      "-C",
      test.materialized.path,
      "init",
      "--initial-branch=main",
    ]);
    await execFileAsync("git", [
      "-C",
      test.materialized.path,
      "remote",
      "add",
      "origin",
      "https://github.com/ArcaneArts/Elsewhere.git",
    ]);

    const result = await test.converter.preflight({ projectId, repository });
    expect(result).toMatchObject({
      status: "blocked",
      error: { code: "local-git-ambiguous", retryable: false },
    });
    expect(
      await readFile(
        path.join(test.materialized.path, ".git", "config"),
        "utf8",
      ),
    ).toContain("ArcaneArts/Elsewhere.git");
  });
});
