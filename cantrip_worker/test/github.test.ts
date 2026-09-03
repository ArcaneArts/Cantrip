import { execFile } from "node:child_process";
import {
  access,
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  GithubClient,
  githubCloneFailureDetails,
  isWindowsLongPathGitFailure,
  parseGithubCloneProgress,
  readProjectWorktreePolicy,
  summarizeGithubCloneFailure,
} from "../src/github.js";
import { githubInboxSearchQuery } from "../src/github-inbox.js";

const directories: string[] = [];
const originalPath = process.env.PATH;
const execFileAsync = promisify(execFile);

afterEach(async () => {
  process.env.PATH = originalPath;
  delete process.env.GIT_CONFIG_COUNT;
  delete process.env.GIT_CONFIG_KEY_0;
  delete process.env.GIT_CONFIG_VALUE_0;
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("GitHub inbox saved queries", () => {
  it("maps every saved view to the narrowest safe GitHub search", () => {
    const query = (view: Parameters<typeof githubInboxSearchQuery>[3]) =>
      githubInboxSearchQuery(
        "ArcaneArts/Cantrip",
        "pull-request",
        "open",
        view,
      );

    expect(query("all")).toBe("repo:ArcaneArts/Cantrip is:pr is:open");
    expect(query("needs-review")).toContain("review-requested:@me");
    expect(query("failed-checks")).toContain("status:failure");
    expect(query("merge-conflicts")).toBe(query("all"));
    expect(query("approved-ready")).toContain("review:approved -is:draft");
    expect(query("approved-ready")).not.toContain("status:success");
    expect(query("stale")).toMatch(/updated:<\d{4}-\d{2}-\d{2}/u);
    expect(query("assigned-to-me")).toContain("assignee:@me");
    expect(query("activity")).toContain("mentions:@me");
  });
});

describe("GitHub project files", () => {
  it("clones direct placements through owned staging and recovers ownership", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-direct-replica-test-"),
    );
    directories.push(dataDirectory);
    const fakeGithub = path.join(dataDirectory, "github");
    const bareRepository = path.join(fakeGithub, "ArcaneArts", "Cantrip.git");
    const seed = path.join(dataDirectory, "seed");
    const binDirectory = path.join(dataDirectory, "bin");
    const target = path.join(
      dataDirectory,
      "external",
      "nested",
      "ArcaneArts",
      "Cantrip",
    );
    await mkdir(path.dirname(bareRepository), { recursive: true });
    await execFileAsync("git", ["init", "--bare", bareRepository]);
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "direct\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "remote",
      "add",
      "origin",
      bareRepository,
    ]);
    await execFileAsync("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await execFileAsync("git", [
      "--git-dir",
      bareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);

    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${fakeGithub}${path.sep}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] !== "repo" || args[1] !== "clone") process.exit(2);',
        'const result = spawnSync("git", ["clone", `https://github.com/${args[2]}.git`, args[3]], { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = [binDirectory, originalPath ?? ""].join(path.delimiter);

    const github = new GithubClient(dataDirectory, "worker-direct");
    const request = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb330",
      attempt: 1,
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb331",
      nameWithOwner: "ArcaneArts/Cantrip",
      placement: { mode: "direct" as const, path: target },
      expectedRevision: null,
    };
    const canonicalTarget = path.join(
      await realpath(dataDirectory),
      path.relative(dataDirectory, target),
    );
    await expect(github.provisionReplica(request)).resolves.toMatchObject({
      status: "ready",
      path: canonicalTarget,
      displayPath: target,
      reused: false,
      placement: {
        mode: "direct",
        materialization: "cloned",
        ownership: "cantrip",
        canonicalPath: canonicalTarget,
        requestedPath: target,
        linkPath: null,
      },
    });
    expect((await stat(path.dirname(target))).isDirectory()).toBe(true);
    const marker = JSON.parse(
      await readFile(
        path.join(target, ".git", "cantrip-project-owner.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    expect(marker).toMatchObject({
      createdBy: "cantrip",
      projectId: request.projectId,
      workerId: "worker-direct",
    });
    await execFileAsync("git", [
      "-C",
      target,
      "remote",
      "set-url",
      "origin",
      "https://github.com/ArcaneArts/Cantrip.git",
    ]);

    const retryResult = await github.provisionReplica({
      ...request,
      attempt: 2,
    });
    expect(retryResult, JSON.stringify(retryResult)).toMatchObject({
      status: "ready",
      reused: true,
      placement: {
        materialization: "reused",
        ownership: "cantrip",
      },
    });
    await expect(
      github.provisionReplica({
        ...request,
        attempt: 3,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb336",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: {
        code: "target-owned-by-another-project",
        retryable: false,
      },
    });
    await rm(path.join(dataDirectory, "project-replica-placements.json"));
    await expect(
      new GithubClient(dataDirectory, "worker-direct").provisionReplica({
        ...request,
        attempt: 4,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb336",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: {
        code: "target-owned-by-another-project",
        retryable: false,
      },
    });
    const recovered = await new GithubClient(
      dataDirectory,
      "worker-direct",
    ).provisionReplica({ ...request, attempt: 5 });
    if (recovered.status !== "ready" || !recovered.placement) {
      throw new Error("Direct ownership recovery did not complete.");
    }
    if (!recovered.resolvedRevision) {
      throw new Error("Direct repository has no resolved revision.");
    }
    await expect(
      github.synchronizeReplica({
        jobId: request.jobId,
        attempt: 6,
        projectId: request.projectId,
        nameWithOwner: request.nameWithOwner,
        sourcePath: recovered.path,
        placement: recovered.placement,
        repositoryFingerprint: recovered.repositoryFingerprint,
        expectedRevision: recovered.resolvedRevision,
        policy: "verify-only",
      }),
    ).resolves.toMatchObject({
      status: "ready",
      changed: false,
    });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 7,
        projectId: request.projectId,
        nameWithOwner: request.nameWithOwner,
        sourcePath: recovered.path,
        placement: recovered.placement,
        repositoryFingerprint: recovered.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      ownershipReleased: true,
    });
    await expect(access(target)).resolves.toBeUndefined();
    await expect(
      access(path.join(target, ".git", "cantrip-project-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 8,
        projectId: request.projectId,
        nameWithOwner: request.nameWithOwner,
        sourcePath: recovered.path,
        placement: recovered.placement,
        repositoryFingerprint: recovered.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      ownershipReleased: true,
    });

    const deleteTarget = path.join(dataDirectory, "delete", "Cantrip");
    const deleteRequest = {
      ...request,
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb347",
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb348",
      placement: { mode: "direct" as const, path: deleteTarget },
    };
    const deletion = await github.provisionReplica(deleteRequest);
    if (deletion.status !== "ready" || !deletion.placement) {
      throw new Error("Direct deletion fixture did not provision.");
    }
    await expect(
      github.removeReplica({
        jobId: deleteRequest.jobId,
        attempt: 2,
        projectId: deleteRequest.projectId,
        nameWithOwner: deleteRequest.nameWithOwner,
        sourcePath: deletion.path,
        placement: deletion.placement,
        repositoryFingerprint: deletion.repositoryFingerprint,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: true,
      ownershipReleased: true,
    });
    await expect(access(deleteTarget)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("attaches an existing dirty Primary checkout without mutating it", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-direct-attach-test-"),
    );
    directories.push(dataDirectory);
    const bareRepository = path.join(dataDirectory, "Cantrip.git");
    const seed = path.join(dataDirectory, "seed");
    const target = path.join(dataDirectory, "existing", "Cantrip");
    await execFileAsync("git", ["init", "--bare", bareRepository]);
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "attached\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "remote",
      "add",
      "origin",
      "https://github.com/ArcaneArts/Cantrip.git",
    ]);
    await execFileAsync("git", ["-C", seed, "push", bareRepository, "main"]);
    await execFileAsync("git", [
      "--git-dir",
      bareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await mkdir(path.dirname(target), { recursive: true });
    await execFileAsync("git", ["clone", bareRepository, target]);
    await execFileAsync("git", [
      "-C",
      target,
      "remote",
      "set-url",
      "origin",
      "git@github.com:ArcaneArts/Cantrip.git",
    ]);
    await writeFile(path.join(target, "LOCAL.txt"), "keep me\n");
    const revision = (
      await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"])
    ).stdout.trim();
    const before = (
      await execFileAsync("git", [
        "-C",
        target,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout;

    const github = new GithubClient(dataDirectory, "worker-attach");
    const request = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb332",
      attempt: 1,
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb333",
      nameWithOwner: "ArcaneArts/Cantrip",
      placement: { mode: "direct" as const, path: target },
      expectedRevision: null,
    };
    const attached = await github.provisionReplica(request);
    expect(attached).toMatchObject({
      status: "ready",
      resolvedRevision: revision,
      placement: {
        materialization: "attached",
        ownership: "user",
      },
    });
    if (attached.status !== "ready" || !attached.placement) {
      throw new Error("Existing checkout attachment did not complete.");
    }
    expect(
      (
        await execFileAsync("git", [
          "-C",
          target,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).stdout,
    ).toBe(before);
    await expect(
      access(path.join(target, ".git", "cantrip-project-owner.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    await expect(
      github.provisionReplica({
        ...request,
        attempt: 2,
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "worktree-dirty", retryable: false },
    });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 3,
        projectId: request.projectId,
        nameWithOwner: request.nameWithOwner,
        sourcePath: attached.path,
        placement: attached.placement,
        repositoryFingerprint: attached.repositoryFingerprint,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "policy-denied", retryable: false },
    });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 4,
        projectId: request.projectId,
        nameWithOwner: request.nameWithOwner,
        sourcePath: attached.path,
        placement: attached.placement,
        repositoryFingerprint: attached.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      ownershipReleased: true,
    });
    await expect(
      readFile(path.join(target, "LOCAL.txt"), "utf8"),
    ).resolves.toBe("keep me\n");
  });

  it("rejects unsafe direct targets before invoking GitHub clone", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-direct-path-guard-test-"),
    );
    directories.push(dataDirectory);
    const github = new GithubClient(dataDirectory, "worker-guard");
    const base = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb334",
      attempt: 1,
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb335",
      nameWithOwner: "ArcaneArts/Cantrip",
      expectedRevision: null,
    };
    await expect(
      github.provisionReplica({
        ...base,
        placement: { mode: "direct", path: "relative/Cantrip" },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "path-invalid", retryable: false },
    });

    const existingFile = path.join(dataDirectory, "existing-file");
    await writeFile(existingFile, "do not replace\n");
    await expect(
      github.provisionReplica({
        ...base,
        placement: { mode: "direct", path: existingFile },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "target-type-mismatch", retryable: false },
    });
    expect(await readFile(existingFile, "utf8")).toBe("do not replace\n");
  });

  it("attaches and detaches a local-only Git source without cloning or changing files", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-local-git-source-test-"),
    );
    directories.push(dataDirectory);
    const target = path.join(dataDirectory, "existing", "repository");
    await mkdir(target, { recursive: true });
    await execFileAsync("git", ["init", "--initial-branch=main", target]);
    await writeFile(path.join(target, "README.md"), "local only\n");
    await execFileAsync("git", ["-C", target, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      target,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await writeFile(path.join(target, "LOCAL.txt"), "preserve me\n");
    const revision = (
      await execFileAsync("git", ["-C", target, "rev-parse", "HEAD"])
    ).stdout.trim();
    const before = (
      await execFileAsync("git", [
        "-C",
        target,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ])
    ).stdout;
    const github = new GithubClient(dataDirectory, "worker-local-source");
    const request = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb3a0",
      attempt: 1,
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb3a1",
      nameWithOwner: null,
      placement: { mode: "direct" as const, path: target },
      expectedRevision: revision,
    };

    const attached = await github.provisionReplica(request);
    expect(attached).toMatchObject({
      status: "ready",
      resolvedRevision: revision,
      placement: {
        materialization: "attached",
        ownership: "user",
      },
    });
    if (attached.status !== "ready" || !attached.placement) {
      throw new Error("Local Git source attachment did not complete.");
    }
    expect(
      (
        await execFileAsync("git", [
          "-C",
          target,
          "status",
          "--porcelain=v1",
          "--untracked-files=all",
        ])
      ).stdout,
    ).toBe(before);
    await expect(
      github.provisionReplica({
        ...request,
        attempt: 2,
        placement: {
          mode: "direct",
          path: path.join(dataDirectory, "missing", "repository"),
        },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "target-not-found", retryable: false },
    });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 3,
        projectId: request.projectId,
        nameWithOwner: null,
        sourcePath: attached.path,
        placement: attached.placement,
        repositoryFingerprint: attached.repositoryFingerprint,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "policy-denied", retryable: false },
    });
    await expect(
      github.removeReplica({
        jobId: request.jobId,
        attempt: 4,
        projectId: request.projectId,
        nameWithOwner: null,
        sourcePath: attached.path,
        placement: attached.placement,
        repositoryFingerprint: attached.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      ownershipReleased: true,
    });
    await expect(
      readFile(path.join(target, "LOCAL.txt"), "utf8"),
    ).resolves.toBe("preserve me\n");
  });

  it("creates, repairs, retains, and safely removes managed repository links", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-managed-link-test-"),
    );
    directories.push(dataDirectory);
    const bareRepository = path.join(
      dataDirectory,
      "remotes",
      "ArcaneArts",
      "Cantrip.git",
    );
    const anotherBareRepository = path.join(
      dataDirectory,
      "remotes",
      "ArcaneArts",
      "Another.git",
    );
    const seed = path.join(dataDirectory, "seed");
    const managed = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    const anotherManaged = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Another",
    );
    const firstLink = path.join(dataDirectory, "links", "first", "Cantrip");
    const secondLink = path.join(dataDirectory, "links", "second", "Cantrip");
    const thirdLink = path.join(dataDirectory, "links", "third", "Cantrip");
    await mkdir(path.dirname(bareRepository), { recursive: true });
    await execFileAsync("git", ["init", "--bare", bareRepository]);
    await execFileAsync("git", ["init", "--bare", anotherBareRepository]);
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "managed link\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", ["-C", seed, "push", bareRepository, "main"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "push",
      anotherBareRepository,
      "main",
    ]);
    await execFileAsync("git", [
      "--git-dir",
      bareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await execFileAsync("git", [
      "--git-dir",
      anotherBareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    await mkdir(path.dirname(managed), { recursive: true });
    await execFileAsync("git", ["clone", bareRepository, managed]);
    await execFileAsync("git", [
      "clone",
      anotherBareRepository,
      anotherManaged,
    ]);

    const github = new GithubClient(dataDirectory, "worker-link");
    const firstRequest = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb340",
      attempt: 1,
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb341",
      nameWithOwner: "ArcaneArts/Cantrip",
      placement: { mode: "managed-link" as const, path: firstLink },
      expectedRevision: null,
    };
    const first = await github.provisionReplica(firstRequest);
    expect(first).toMatchObject({
      status: "ready",
      placement: {
        mode: "managed-link",
        materialization: "reused",
        ownership: "cantrip",
      },
    });
    if (first.status !== "ready" || !first.placement) {
      throw new Error("Managed-link setup did not complete.");
    }
    expect((await lstat(first.placement.linkPath!)).isSymbolicLink()).toBe(
      true,
    );
    expect(await realpath(first.placement.linkPath!)).toBe(first.path);

    await rm(first.placement.linkPath!);
    await expect(
      github.repairReplicaLink({
        projectId: firstRequest.projectId,
        nameWithOwner: firstRequest.nameWithOwner,
        sourcePath: first.path,
        linkPath: first.placement.linkPath!,
        repositoryFingerprint: first.repositoryFingerprint,
      }),
    ).resolves.toMatchObject({ status: "ready", repaired: true });
    const repaired = await github.provisionReplica({
      ...firstRequest,
      attempt: 2,
    });
    expect(repaired).toMatchObject({ status: "ready", reused: true });
    if (repaired.status !== "ready" || !repaired.placement) {
      throw new Error("Managed-link repair did not complete.");
    }
    expect(await realpath(repaired.placement.linkPath!)).toBe(repaired.path);

    await expect(
      github.removeReplica({
        jobId: firstRequest.jobId,
        attempt: 3,
        projectId: firstRequest.projectId,
        nameWithOwner: firstRequest.nameWithOwner,
        sourcePath: repaired.path,
        placement: repaired.placement,
        repositoryFingerprint: repaired.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      linkRemoved: false,
      ownershipReleased: true,
    });
    await expect(
      github.removeReplica({
        jobId: firstRequest.jobId,
        attempt: 4,
        projectId: firstRequest.projectId,
        nameWithOwner: firstRequest.nameWithOwner,
        sourcePath: repaired.path,
        placement: repaired.placement,
        repositoryFingerprint: repaired.repositoryFingerprint,
        deleteLocalFiles: false,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: false,
      ownershipReleased: true,
    });
    await expect(access(managed)).resolves.toBeUndefined();
    expect(await realpath(repaired.placement.linkPath!)).toBe(repaired.path);
    await expect(
      github.provisionReplica({
        ...firstRequest,
        attempt: 5,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb342",
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "ownership-proof-missing" },
    });
    await expect(
      github.provisionReplica({
        ...firstRequest,
        attempt: 6,
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb342",
        placement: { mode: "managed-link", path: secondLink },
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "ownership-proof-missing" },
    });

    const secondRequest = {
      ...firstRequest,
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb343",
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb344",
      nameWithOwner: "ArcaneArts/Another",
      placement: { mode: "managed-link" as const, path: secondLink },
    };
    const second = await github.provisionReplica(secondRequest);
    if (second.status !== "ready" || !second.placement) {
      throw new Error("Second managed-link setup did not complete.");
    }
    await expect(
      github.removeReplica({
        jobId: secondRequest.jobId,
        attempt: 2,
        projectId: secondRequest.projectId,
        nameWithOwner: secondRequest.nameWithOwner,
        sourcePath: second.path,
        placement: second.placement,
        repositoryFingerprint: second.repositoryFingerprint,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: true,
      linkRemoved: true,
      ownershipReleased: true,
      warning: null,
    });
    await expect(access(anotherManaged)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(access(secondLink)).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(firstLink)).isSymbolicLink()).toBe(true);

    await execFileAsync("git", [
      "clone",
      anotherBareRepository,
      anotherManaged,
    ]);
    const thirdRequest = {
      ...firstRequest,
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb345",
      projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb346",
      nameWithOwner: "ArcaneArts/Another",
      placement: { mode: "managed-link" as const, path: thirdLink },
    };
    const third = await github.provisionReplica(thirdRequest);
    if (third.status !== "ready" || !third.placement) {
      throw new Error("Third managed-link setup did not complete.");
    }
    const unrelatedTarget = path.join(dataDirectory, "unrelated-target");
    await rm(third.placement.linkPath!);
    await mkdir(unrelatedTarget);
    await symlink(
      unrelatedTarget,
      third.placement.linkPath!,
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      github.removeReplica({
        jobId: thirdRequest.jobId,
        attempt: 2,
        projectId: thirdRequest.projectId,
        nameWithOwner: thirdRequest.nameWithOwner,
        sourcePath: third.path,
        placement: third.placement,
        repositoryFingerprint: third.repositoryFingerprint,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: true,
      linkRemoved: false,
      ownershipReleased: true,
      warning: expect.stringContaining("left untouched"),
    });
    expect(await realpath(third.placement.linkPath!)).toBe(
      await realpath(unrelatedTarget),
    );
    await expect(access(managed)).resolves.toBeUndefined();
    expect(await realpath(firstLink)).toBe(await realpath(managed));
  });

  it("provisions an exact revision without mutating dirty or diverged replicas", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-replica-provision-test-"),
    );
    directories.push(dataDirectory);
    const fakeGithub = path.join(dataDirectory, "github");
    const bareRepository = path.join(fakeGithub, "ArcaneArts", "Cantrip.git");
    const seed = path.join(dataDirectory, "seed");
    const managed = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    await mkdir(path.dirname(bareRepository), { recursive: true });
    await execFileAsync("git", ["init", "--bare", bareRepository]);
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "exact\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "remote",
      "add",
      "origin",
      bareRepository,
    ]);
    await execFileAsync("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await execFileAsync("git", [
      "--git-dir",
      bareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    const revision = (
      await execFileAsync("git", ["-C", seed, "rev-parse", "HEAD"])
    ).stdout.trim();

    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${fakeGithub}${path.sep}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    await mkdir(path.dirname(managed), { recursive: true });
    await execFileAsync("git", [
      "clone",
      "https://github.com/ArcaneArts/Cantrip.git",
      managed,
    ]);

    const github = new GithubClient(dataDirectory);
    const stages: string[] = [];
    await expect(
      github.provisionReplica(
        {
          jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb336",
          attempt: 1,
          nameWithOwner: "ArcaneArts/Cantrip",
          expectedRevision: revision,
        },
        (progress) => stages.push(progress.stage),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      resolvedRevision: revision,
      branch: "main",
      reused: true,
    });
    expect(stages).toEqual([
      "validating",
      "fetching",
      "inspecting",
      "verifying",
    ]);

    await writeFile(path.join(managed, "LOCAL.txt"), "dirty\n");
    await expect(
      github.provisionReplica({
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb336",
        attempt: 2,
        nameWithOwner: "ArcaneArts/Cantrip",
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "worktree-dirty", retryable: false },
    });
    await rm(path.join(managed, "LOCAL.txt"));
    await writeFile(path.join(managed, "README.md"), "diverged\n");
    await execFileAsync("git", ["-C", managed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      managed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Local divergence",
    ]);
    await expect(
      github.provisionReplica({
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb336",
        attempt: 3,
        nameWithOwner: "ArcaneArts/Cantrip",
        expectedRevision: revision,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "revision-diverged", retryable: false },
    });
  });

  it("provisions an empty repository and attaches it after the first commit", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-empty-replica-recovery-test-"),
    );
    directories.push(dataDirectory);
    const fakeGithub = path.join(dataDirectory, "github");
    const bareRepository = path.join(fakeGithub, "ArcaneArts", "Cantrip.git");
    const seed = path.join(dataDirectory, "seed");
    const binDirectory = path.join(dataDirectory, "bin");
    const managed = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    await mkdir(path.dirname(bareRepository), { recursive: true });
    await execFileAsync("git", [
      "init",
      "--bare",
      "--initial-branch=main",
      bareRepository,
    ]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${fakeGithub}${path.sep}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const { spawnSync } = require("node:child_process");',
        "const args = process.argv.slice(2);",
        'if (args[0] !== "repo" || args[1] !== "clone") process.exit(2);',
        'const result = spawnSync("git", ["clone", `https://github.com/${args[2]}.git`, args[3]], { stdio: "inherit" });',
        "process.exit(result.status ?? 1);",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = [binDirectory, originalPath ?? ""].join(path.delimiter);

    const github = new GithubClient(dataDirectory);
    const initialStages: string[] = [];
    await expect(
      github.provisionReplica(
        {
          jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
          attempt: 1,
          nameWithOwner: "ArcaneArts/Cantrip",
          expectedRevision: null,
        },
        (progress) => initialStages.push(progress.stage),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      resolvedRevision: null,
      branch: "main",
      reused: false,
    });
    await expect(access(managed)).resolves.toBeUndefined();
    expect(initialStages).toEqual(["validating", "materializing", "verifying"]);

    await expect(
      github.provisionReplica({
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
        attempt: 2,
        nameWithOwner: "ArcaneArts/Cantrip",
        expectedRevision: null,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      resolvedRevision: null,
      branch: "main",
      reused: true,
    });

    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, "README.md"), "initialized\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "remote",
      "add",
      "origin",
      bareRepository,
    ]);
    await execFileAsync("git", ["-C", seed, "push", "origin", "main"]);
    const revision = (
      await execFileAsync("git", ["-C", seed, "rev-parse", "HEAD"])
    ).stdout.trim();

    const stages: string[] = [];
    await expect(
      github.provisionReplica(
        {
          jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb338",
          attempt: 3,
          nameWithOwner: "ArcaneArts/Cantrip",
          expectedRevision: null,
        },
        (progress) => stages.push(progress.stage),
      ),
    ).resolves.toMatchObject({
      status: "ready",
      resolvedRevision: revision,
      branch: "main",
      reused: true,
    });
    await expect(
      readFile(path.join(managed, "README.md"), "utf8"),
    ).resolves.toBe("initialized\n");
    expect(stages).toEqual([
      "validating",
      "fetching",
      "inspecting",
      "verifying",
    ]);
  });

  it("maps streamed Git clone output to durable progress", () => {
    expect(
      parseGithubCloneProgress(
        "remote: Counting objects: 100%\rReceiving objects: 42% (42/100)",
      ),
    ).toEqual({
      percent: 47,
    });
    expect(
      parseGithubCloneProgress(
        "Receiving objects: 100%\rResolving deltas: 50% (10/20)",
      ),
    ).toEqual({
      percent: 78,
    });
  });

  it("isolates Git diagnostics from carriage-return progress output", () => {
    const failure = summarizeGithubCloneFailure(
      [
        "Receiving objects: 14%\rReceiving objects: 42%\rReceiving objects: 100%",
        "error: unable to open loose object abc: Filename too long",
        "fatal: cannot write keep file C:\\deep\\pack.keep: Filename too long",
        "fatal: fetch-pack: invalid index-pack output",
      ].join("\n"),
    );

    expect(failure).toBe(
      [
        "error: unable to open loose object abc: Filename too long",
        "fatal: cannot write keep file C:\\deep\\pack.keep: Filename too long",
        "fatal: fetch-pack: invalid index-pack output",
      ].join("\n"),
    );
    expect(failure).not.toContain("Receiving objects");
  });

  it("classifies only Windows filename-too-long Git failures", () => {
    const output =
      "fatal: cannot write keep file C:\\deep\\pack.keep: Filename too long";
    expect(isWindowsLongPathGitFailure(output, "win32")).toBe(true);
    expect(isWindowsLongPathGitFailure(output, "darwin")).toBe(false);
    expect(
      isWindowsLongPathGitFailure(
        "fatal: unable to access repository: connection reset",
        "win32",
      ),
    ).toBe(false);
    expect(githubCloneFailureDetails(output, "win32")).toEqual({
      code: "windows-long-paths-disabled",
      message: expect.stringContaining("Enable Git long paths"),
    });
    expect(
      githubCloneFailureDetails("fatal: the remote disconnected", "win32"),
    ).toEqual({
      code: "remote-unavailable",
      message: "Could not clone the repository: fatal: the remote disconnected",
    });
  });

  it("synchronizes only by policy and removes only fully published replicas", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-replica-lifecycle-test-"),
    );
    directories.push(dataDirectory);
    const fakeGithub = path.join(dataDirectory, "github");
    const bareRepository = path.join(fakeGithub, "ArcaneArts", "Cantrip.git");
    const seed = path.join(dataDirectory, "seed");
    const managed = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    await mkdir(path.dirname(bareRepository), { recursive: true });
    await execFileAsync("git", ["init", "--bare", bareRepository]);
    await execFileAsync("git", ["init", "--initial-branch=main", seed]);
    await writeFile(path.join(seed, ".gitignore"), "secret.tmp\n");
    await writeFile(path.join(seed, "README.md"), "one\n");
    await execFileAsync("git", ["-C", seed, "add", ".gitignore", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Initial",
    ]);
    await execFileAsync("git", [
      "-C",
      seed,
      "remote",
      "add",
      "origin",
      bareRepository,
    ]);
    await execFileAsync("git", ["-C", seed, "push", "-u", "origin", "main"]);
    await execFileAsync("git", [
      "--git-dir",
      bareRepository,
      "symbolic-ref",
      "HEAD",
      "refs/heads/main",
    ]);
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = `url.${fakeGithub}${path.sep}.insteadOf`;
    process.env.GIT_CONFIG_VALUE_0 = "https://github.com/";
    await mkdir(path.dirname(managed), { recursive: true });
    await execFileAsync("git", [
      "clone",
      "https://github.com/ArcaneArts/Cantrip.git",
      managed,
    ]);

    await writeFile(path.join(seed, "README.md"), "two\n");
    await execFileAsync("git", ["-C", seed, "add", "README.md"]);
    await execFileAsync("git", [
      "-C",
      seed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Second",
    ]);
    await execFileAsync("git", ["-C", seed, "push", "origin", "main"]);
    const revision = (
      await execFileAsync("git", ["-C", seed, "rev-parse", "HEAD"])
    ).stdout.trim();
    const github = new GithubClient(dataDirectory);
    const operation = {
      jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb337",
      attempt: 1,
      nameWithOwner: "ArcaneArts/Cantrip",
      sourcePath: managed,
      expectedRevision: revision,
    };
    await expect(
      github.synchronizeReplica({ ...operation, policy: "verify-only" }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "revision-diverged" },
    });
    await expect(
      github.synchronizeReplica({
        ...operation,
        attempt: 2,
        policy: "fast-forward-primary",
        sourcePath: pathToFileURL(managed).href,
      }),
    ).resolves.toMatchObject({
      status: "ready",
      changed: true,
      path: await realpath(managed),
      resolvedRevision: revision,
    });

    await writeFile(path.join(managed, "secret.tmp"), "local secret\n");
    await expect(
      github.removeReplica({
        jobId: operation.jobId,
        attempt: 3,
        nameWithOwner: operation.nameWithOwner,
        sourcePath: managed,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "worktree-dirty" },
    });
    await rm(path.join(managed, "secret.tmp"));
    await writeFile(path.join(managed, "LOCAL.md"), "unpublished\n");
    await execFileAsync("git", ["-C", managed, "add", "LOCAL.md"]);
    await execFileAsync("git", [
      "-C",
      managed,
      "-c",
      "user.name=Cantrip Test",
      "-c",
      "user.email=cantrip@example.test",
      "commit",
      "-m",
      "Unpublished",
    ]);
    await expect(
      github.removeReplica({
        jobId: operation.jobId,
        attempt: 4,
        nameWithOwner: operation.nameWithOwner,
        sourcePath: managed,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "blocked",
      error: { code: "unpushed-commits" },
    });
    await execFileAsync("git", [
      "-C",
      managed,
      "reset",
      "--hard",
      "origin/main",
    ]);
    await expect(
      github.removeReplica({
        jobId: operation.jobId,
        attempt: 5,
        nameWithOwner: operation.nameWithOwner,
        sourcePath: managed,
        deleteLocalFiles: true,
      }),
    ).resolves.toMatchObject({
      status: "removed",
      localFilesDeleted: true,
    });
    await expect(access(managed)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads an optional repository worktree policy without trusting invalid files", async () => {
    const repository = await mkdtemp(
      path.join(tmpdir(), "cantrip-project-policy-test-"),
    );
    directories.push(repository);
    const policyDirectory = path.join(repository, ".cantrip");
    await mkdir(policyDirectory);
    const policyPath = path.join(policyDirectory, "project.json");
    await writeFile(
      policyPath,
      JSON.stringify({ worktreePolicy: "required-for-writes" }),
    );
    await expect(readProjectWorktreePolicy(repository)).resolves.toEqual({
      policy: "required-for-writes",
      warning: null,
    });

    await writeFile(policyPath, JSON.stringify({ worktreePolicy: "unsafe" }));
    await expect(readProjectWorktreePolicy(repository)).resolves.toEqual({
      policy: null,
      warning: expect.stringContaining("worktreePolicy is invalid"),
    });
  });

  it("lists repository owners and creates a repository through GitHub CLI", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-repository-create-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const repository = {
      id: 123,
      name: "cantrip-labs",
      full_name: "ArcaneArts/cantrip-labs",
      description: "A Cantrip project",
      private: true,
      fork: false,
      html_url: "https://github.com/ArcaneArts/cantrip-labs",
      default_branch: "main",
      updated_at: "2026-08-11T12:00:00.000Z",
    };
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const log = " + JSON.stringify(logPath) + ";",
        'const args = process.argv.slice(2); fs.appendFileSync(log, args.join("\\0") + "\\n");',
        'if (args[0] === "api" && args[1] === "user") process.stdout.write("cyberpwnn\\n");',
        'else if (args.includes("user/orgs")) process.stdout.write(' +
          JSON.stringify(
            JSON.stringify([[{ login: "ArcaneArts" }, { login: "MPM" }]]),
          ) +
          ");",
        'else if (args.includes("repos/ArcaneArts/cantrip-labs")) process.stdout.write(' +
          JSON.stringify(JSON.stringify(repository)) +
          ");",
        'else if (args[0] !== "repo" || args[1] !== "create") process.exit(1);',
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = [binDirectory, originalPath ?? ""].join(path.delimiter);

    const github = new GithubClient(dataDirectory);
    await expect(github.listRepositoryOwners()).resolves.toEqual([
      { login: "cyberpwnn", kind: "user" },
      { login: "ArcaneArts", kind: "organization" },
      { login: "MPM", kind: "organization" },
    ]);
    await expect(
      github.createRepository({
        owner: "ArcaneArts",
        name: "cantrip-labs",
        description: "A Cantrip project",
        visibility: "private",
        initialize: "readme",
      }),
    ).resolves.toMatchObject({
      id: "123",
      nameWithOwner: "ArcaneArts/cantrip-labs",
      isPrivate: true,
    });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain(
      "repo\0create\0ArcaneArts/cantrip-labs\0--private\0--add-readme\0--description\0A Cantrip project",
    );
    await github.createRepository({
      owner: "ArcaneArts",
      name: "cantrip-labs",
      description: "A Cantrip project",
      visibility: "private",
      initialize: "empty",
    });
    expect((await readFile(logPath, "utf8")).split("\n")).toContain(
      "repo\0create\0ArcaneArts/cantrip-labs\0--private\0--description\0A Cantrip project",
    );
  });

  it("counts open issues with GitHub search", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-issue-count-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join("\\0"));`,
        "process.stdout.write(JSON.stringify({ total_count: 7, items: [] }));",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = [binDirectory, originalPath ?? ""].join(path.delimiter);

    await expect(
      new GithubClient(dataDirectory).countOpenIssues("ArcaneArts/Cantrip"),
    ).resolves.toBe(7);
    expect(await readFile(logPath, "utf8")).toContain(
      "q=repo:ArcaneArts/Cantrip is:issue is:open",
    );
  });

  it("lists issues and pull requests separately and supports issue detail mutations", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-issues-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const issue = JSON.stringify({
      number: 42,
      title: "Issue title",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/issues/42",
      user: { login: "author" },
      comments: 1,
      labels: [{ name: "feature", color: "22d3ee" }],
      created_at: "2026-08-07T12:00:00.000Z",
      updated_at: "2026-08-07T13:00:00.000Z",
      closed_at: null,
      body: "Issue body",
    });
    const pullRequest = JSON.stringify({
      ...JSON.parse(issue),
      number: 43,
      pull_request: { url: "https://api.github.com/pulls/43" },
    });
    const comment = JSON.stringify({
      id: 99,
      user: { login: "reviewer" },
      body: "A comment",
      html_url:
        "https://github.com/ArcaneArts/Cantrip/issues/42#issuecomment-99",
      created_at: "2026-08-07T12:30:00.000Z",
      updated_at: "2026-08-07T12:30:00.000Z",
    });
    await writeFile(
      fakeGh,
      [
        "#!/bin/sh",
        'case "$*" in',
        `  *"/issues/42/comments --method GET"*) printf '%s' '${JSON.stringify([[JSON.parse(comment)]])}' ;;`,
        `  *"/issues/42/comments --method POST"*) printf '%s' '${comment}' ;;`,
        `  *"/issues/42 --method PATCH"*) printf '%s' '${issue}' ;;`,
        `  *"/issues/42"*) printf '%s' '${issue}' ;;`,
        `  *"/issues --method POST -f title=New issue -f body=Issue details"*) printf '%s' '${issue}' ;;`,
        `  *"/issues --method GET -f per_page=50 -f page=2"*) printf '%s' '${JSON.stringify([JSON.parse(issue), JSON.parse(pullRequest)])}' ;;`,
        "  *) exit 1 ;;",
        "esac",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    await expect(
      github.listIssues("ArcaneArts/Cantrip", "issue", "open", 2, 50),
    ).resolves.toMatchObject({
      kind: "issue",
      total: 1,
      issues: [{ number: 42 }],
      nextPage: null,
    });
    await expect(
      github.listIssues("ArcaneArts/Cantrip", "pull-request", "open", 2, 50),
    ).resolves.toMatchObject({
      kind: "pull-request",
      total: 1,
      issues: [{ number: 43 }],
      nextPage: null,
    });
    await expect(
      github.getIssue("ArcaneArts/Cantrip", 42),
    ).resolves.toMatchObject({
      body: "Issue body",
      comments: [{ author: "reviewer", body: "A comment" }],
    });
    await expect(
      github.createIssue("ArcaneArts/Cantrip", {
        title: "New issue",
        body: "Issue details",
      }),
    ).resolves.toMatchObject({
      number: 42,
      body: "Issue body",
      comments: [],
    });
    await expect(
      github.commentOnIssue("ArcaneArts/Cantrip", 42, "New comment"),
    ).resolves.toMatchObject({ number: 42 });
    await expect(
      github.closeIssue("ArcaneArts/Cantrip", 42, "Closing"),
    ).resolves.toMatchObject({ number: 42 });
  });

  it("lists pull requests with branch metadata in one bounded request", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-list-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const pullRequest = {
      number: 43,
      title: "Task implementation",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/43",
      user: { login: "author" },
      comments: 1,
      labels: [],
      created_at: "2026-08-07T12:00:00.000Z",
      updated_at: "2026-08-07T13:00:00.000Z",
      closed_at: null,
      body: "Implements the Task.",
      draft: false,
      merged: false,
      head: { ref: "agent/manual/task-cycle", sha: "1".repeat(40) },
      base: { ref: "main", sha: "2".repeat(40) },
    };
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `fs.writeFileSync(${JSON.stringify(logPath)}, process.argv.slice(2).join("\\0"));`,
        `process.stdout.write(${JSON.stringify(JSON.stringify([pullRequest]))});`,
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    await expect(
      new GithubClient(dataDirectory).listPullRequests(
        "ArcaneArts/Cantrip",
        "open",
        2,
        50,
      ),
    ).resolves.toMatchObject({
      state: "open",
      total: 1,
      pullRequests: [
        {
          number: 43,
          headRef: "agent/manual/task-cycle",
          baseRef: "main",
        },
      ],
      nextPage: null,
    });
    const invocation = await readFile(logPath, "utf8");
    expect(invocation).toContain("/pulls");
    expect(invocation).toContain("per_page=50");
    expect(invocation).toContain("page=2");
    expect(invocation).toContain("state=open");
  });

  it("builds a rich pull request inbox with notification attention", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-inbox-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const node = {
      __typename: "PullRequest",
      number: 43,
      title: "Repair the build",
      state: "OPEN",
      url: "https://github.com/ArcaneArts/Cantrip/pull/43",
      author: { login: "author" },
      comments: { totalCount: 3 },
      labels: { nodes: [{ name: "bug", color: "ef4444" }] },
      assignees: { nodes: [{ login: "viewer" }] },
      createdAt: "2099-09-01T12:00:00.000Z",
      updatedAt: "2099-09-02T12:00:00.000Z",
      closedAt: null,
      isDraft: false,
      headRefName: "fix/build",
      baseRefName: "main",
      mergeable: "CONFLICTING",
      reviewDecision: "CHANGES_REQUESTED",
      reviewRequests: {
        nodes: [{ requestedReviewer: { login: "viewer" } }],
      },
      commits: {
        nodes: [{ commit: { statusCheckRollup: { state: "FAILURE" } } }],
      },
    };
    const notification = {
      reason: "review_requested",
      unread: true,
      subject: {
        type: "PullRequest",
        url: "https://api.github.com/repos/ArcaneArts/Cantrip/pulls/43",
      },
    };
    const search = {
      data: {
        search: {
          issueCount: 1,
          pageInfo: { endCursor: "next-page", hasNextPage: true },
          nodes: [node],
        },
      },
    };
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(logPath)}, args.join("\\0") + "\\n");`,
        'if (args[0] === "api" && args[1] === "user") process.stdout.write("viewer\\n");',
        `else if (args[1]?.endsWith("/notifications")) process.stdout.write(${JSON.stringify(JSON.stringify([notification]))});`,
        `else if (args[1] === "graphql") process.stdout.write(${JSON.stringify(JSON.stringify(search))});`,
        "else process.exit(1);",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    await expect(
      new GithubClient(dataDirectory).listInbox(
        "ArcaneArts/Cantrip",
        "pull-request",
        "open",
        "all",
        null,
        50,
      ),
    ).resolves.toMatchObject({
      total: 1,
      nextCursor: "next-page",
      viewerLogin: "viewer",
      activityAvailable: true,
      items: [
        {
          number: 43,
          assignees: ["viewer"],
          attention: expect.arrayContaining([
            "assigned",
            "review-requested",
            "unread",
            "failed-checks",
            "merge-conflict",
          ]),
          pullRequest: {
            headRef: "fix/build",
            baseRef: "main",
            mergeable: "conflicting",
            reviewDecision: "changes-requested",
            checksState: "failure",
          },
        },
      ],
    });
    const invocation = await readFile(logPath, "utf8");
    expect(invocation).toContain("repo:ArcaneArts/Cantrip is:pr is:open");
    expect(invocation).toContain("searchQuery=");
    expect(invocation).toContain("per_page=50");
  });

  it("falls back to GitHub mention search when notifications are unavailable", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-inbox-mention-test-"),
    );
    directories.push(dataDirectory);
    const binDirectory = path.join(dataDirectory, "bin");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    const search = {
      data: {
        search: {
          issueCount: 1,
          pageInfo: { endCursor: null, hasNextPage: false },
          nodes: [
            {
              __typename: "Issue",
              number: 9,
              title: "Mention the maintainer",
              state: "OPEN",
              url: "https://github.com/ArcaneArts/Cantrip/issues/9",
              author: { login: "author" },
              comments: { totalCount: 0 },
              labels: { nodes: [] },
              assignees: { nodes: [] },
              createdAt: "2099-09-01T12:00:00.000Z",
              updatedAt: "2099-09-02T12:00:00.000Z",
              closedAt: null,
            },
          ],
        },
      },
    };
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        'if (args[0] === "api" && args[1] === "user") process.stdout.write("viewer\\n");',
        'else if (args[1]?.endsWith("/notifications")) process.exit(1);',
        `else if (args[1] === "graphql") process.stdout.write(${JSON.stringify(JSON.stringify(search))});`,
        "else process.exit(1);",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    await expect(
      new GithubClient(dataDirectory).listInbox(
        "ArcaneArts/Cantrip",
        "issue",
        "open",
        "activity",
      ),
    ).resolves.toMatchObject({
      activityAvailable: false,
      items: [{ number: 9, attention: ["mention"] }],
    });
  });

  it("creates pull requests only from an exactly published local branch", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-create-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "feature/pr-ui", repository]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(repository, "README.md"), "Cantrip\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", ["-C", repository, "commit", "-m", "Feature"]);
    const head = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    const base = "2".repeat(40);
    const pullRequest = {
      number: 44,
      title: "Add PR creation",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/44",
      user: { login: "author" },
      comments: 0,
      labels: [],
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T12:00:00.000Z",
      closed_at: null,
      body: "Ready for review.\n\nCloses #42",
      draft: true,
      merged: false,
      head: { ref: "feature/pr-ui", sha: head },
      base: { ref: "main", sha: base },
    };
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(logPath)};`,
        'const args = process.argv.slice(2); fs.appendFileSync(log, args.join("\\0") + "\\n");',
        'const path = args[1] || "";',
        `if (path.includes("/git/ref/heads/feature/pr-ui")) process.stdout.write(${JSON.stringify(JSON.stringify({ object: { sha: head } }))});`,
        `else if (path.endsWith("/pulls")) process.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});`,
        'else process.stdout.write("{}");',
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    const created = await github.createPullRequest(
      "ArcaneArts/Cantrip",
      repository,
      {
        base: "main",
        head: "feature/pr-ui",
        title: "Add PR creation",
        body: "Ready for review.",
        draft: true,
        labels: ["feature", "feature"],
        reviewers: ["reviewer"],
        linkedIssueNumbers: [42, 42],
      },
    );
    expect(created).toMatchObject({
      pullRequest: {
        number: 44,
        draft: true,
        headRef: "feature/pr-ui",
        baseRef: "main",
      },
      warnings: [],
    });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain("body=Ready for review.\n\nCloses #42");
    expect(invocations).toContain("draft=true");
    expect(invocations.match(/labels\[\]=feature/gu)).toHaveLength(1);
    expect(invocations).toContain("reviewers[]=reviewer");

    await writeFile(path.join(repository, "README.md"), "Changed locally\n");
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-am",
      "Local only",
    ]);
    await expect(
      github.createPullRequest("ArcaneArts/Cantrip", repository, {
        base: "main",
        head: "feature/pr-ui",
        title: "Stale head",
        body: "",
        draft: false,
        labels: [],
        reviewers: [],
        linkedIssueNumbers: [],
      }),
    ).rejects.toThrow("local and GitHub branch tips must match");
  });

  it("loads a bounded pull request review surface from the selected worktree", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-detail-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "feature/review", repository]);
    const head = "1".repeat(40);
    const base = "2".repeat(40);
    const pullRequest = {
      number: 44,
      title: "Review pull requests",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/44",
      user: { login: "author" },
      comments: 1,
      labels: [{ name: "feature", color: "22d3ee" }],
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T13:00:00.000Z",
      closed_at: null,
      body: "Please review.",
      draft: false,
      merged: false,
      head: { ref: "feature/review", sha: head },
      base: { ref: "main", sha: base },
      requested_reviewers: [{ login: "second-reviewer" }],
      mergeable: false,
      mergeable_state: "blocked",
      additions: 12,
      deletions: 3,
      changed_files: 101,
      commits: 101,
    };
    const comments = [
      {
        id: 9,
        user: { login: "commenter" },
        body: "General feedback",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#issuecomment-9",
        created_at: "2026-08-10T12:10:00.000Z",
        updated_at: "2026-08-10T12:10:00.000Z",
      },
    ];
    const commits = [
      {
        sha: head,
        html_url: `https://github.com/ArcaneArts/Cantrip/commit/${head}`,
        author: { login: "author" },
        commit: {
          message: "feat: review pull requests\n\nDetails",
          author: {
            name: "Cantrip Author",
            date: "2026-08-10T12:00:00.000Z",
          },
        },
      },
    ];
    const files = [
      {
        sha: "3".repeat(40),
        filename: "src/review.ts",
        previous_filename: "src/old-review.ts",
        status: "renamed",
        additions: 12,
        deletions: 3,
        changes: 15,
        blob_url:
          "https://github.com/ArcaneArts/Cantrip/blob/feature/review/src/review.ts",
        raw_url: null,
        patch: "@@ -1 +1 @@\n-old\n+new",
      },
    ];
    const checkRuns = {
      total_count: 1,
      check_runs: [
        {
          id: 10,
          name: "test",
          status: "completed",
          conclusion: "failure",
          details_url: "https://github.com/ArcaneArts/Cantrip/actions/runs/10",
          started_at: "2026-08-10T12:01:00.000Z",
          completed_at: "2026-08-10T12:03:00.000Z",
          output: { title: "Tests failed", summary: "One failure" },
        },
      ],
    };
    const statuses = {
      statuses: [
        {
          id: 11,
          context: "deploy",
          state: "pending",
          description: "Waiting",
          target_url: "https://github.com/ArcaneArts/Cantrip/deployments/11",
          created_at: "2026-08-10T12:02:00.000Z",
          updated_at: "2026-08-10T12:02:00.000Z",
        },
      ],
    };
    const reviews = [
      {
        id: 12,
        user: { login: "reviewer" },
        state: "CHANGES_REQUESTED",
        body: "Please revise this.",
        commit_id: head,
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#pullrequestreview-12",
        submitted_at: "2026-08-10T12:30:00.000Z",
      },
    ];
    const reviewComments = [
      {
        id: 20,
        pull_request_review_id: 12,
        user: { login: "reviewer" },
        body: "Rename this symbol.",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#discussion_r20",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        diff_hunk: "@@ -3,2 +3,2 @@",
        in_reply_to_id: null,
        created_at: "2026-08-10T12:31:00.000Z",
        updated_at: "2026-08-10T12:31:00.000Z",
      },
      {
        id: 21,
        pull_request_review_id: 12,
        user: { login: "author" },
        body: "Done.",
        html_url:
          "https://github.com/ArcaneArts/Cantrip/pull/44#discussion_r21",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        start_line: null,
        start_side: null,
        diff_hunk: "@@ -3,2 +3,2 @@",
        in_reply_to_id: 20,
        created_at: "2026-08-10T12:32:00.000Z",
        updated_at: "2026-08-10T12:32:00.000Z",
      },
    ];
    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(logPath)};`,
        'const args = process.argv.slice(2); fs.appendFileSync(log, args.join("\\0") + "\\n");',
        'const route = args[1] || "";',
        `if (route.endsWith("/pulls/44")) process.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});`,
        `else if (route.endsWith("/issues/44/comments")) process.stdout.write(${JSON.stringify(JSON.stringify(comments))});`,
        `else if (route.endsWith("/pulls/44/commits")) process.stdout.write(${JSON.stringify(JSON.stringify(commits))});`,
        `else if (route.endsWith("/pulls/44/files")) process.stdout.write(${JSON.stringify(JSON.stringify(files))});`,
        `else if (route.endsWith("/check-runs")) process.stdout.write(${JSON.stringify(JSON.stringify(checkRuns))});`,
        `else if (route.endsWith("/status")) process.stdout.write(${JSON.stringify(JSON.stringify(statuses))});`,
        `else if (route.endsWith("/pulls/44/reviews")) process.stdout.write(${JSON.stringify(JSON.stringify(reviews))});`,
        `else if (route.endsWith("/pulls/44/comments")) process.stdout.write(${JSON.stringify(JSON.stringify(reviewComments))});`,
        'else process.stdout.write("{}");',
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const github = new GithubClient(dataDirectory);
    await expect(
      github.getPullRequest("ArcaneArts/Cantrip", repository, 44),
    ).resolves.toMatchObject({
      number: 44,
      mergeable: false,
      reviewDecision: "changes-requested",
      checksState: "failure",
      commitCount: 101,
      commitsTruncated: true,
      changedFileCount: 101,
      filesTruncated: true,
      comments: [{ author: "commenter" }],
      commits: [{ author: "Cantrip Author" }],
      files: [{ path: "src/review.ts", previousPath: "src/old-review.ts" }],
      checks: [
        { name: "test", conclusion: "failure" },
        { name: "deploy", status: "in-progress" },
      ],
      reviews: [{ author: "reviewer", state: "changes-requested" }],
      reviewThreads: [
        {
          path: "src/review.ts",
          line: 4,
          comments: [{ id: 20 }, { id: 21, inReplyToId: 20 }],
        },
      ],
    });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain(`/commits/${head}/check-runs`);
    expect(invocations).toContain("per_page=100");
    await github.commentOnPullRequest(
      "ArcaneArts/Cantrip",
      repository,
      44,
      "General feedback",
    );
    await github.submitPullRequestReview("ArcaneArts/Cantrip", repository, 44, {
      event: "request-changes",
      body: "Please revise.",
    });
    await github.commentOnPullRequestLine(
      "ArcaneArts/Cantrip",
      repository,
      44,
      {
        body: "Inline feedback",
        path: "src/review.ts",
        line: 4,
        side: "RIGHT",
        startLine: null,
        startSide: null,
      },
    );
    await github.replyToPullRequestReview(
      "ArcaneArts/Cantrip",
      repository,
      44,
      20,
      "Updated.",
    );
    const mutationInvocations = await readFile(logPath, "utf8");
    expect(mutationInvocations).toContain("body=General feedback");
    expect(mutationInvocations).toContain("event=REQUEST_CHANGES");
    expect(mutationInvocations).toContain(`commit_id=${head}`);
    expect(mutationInvocations).toContain("path=src/review.ts");
    expect(mutationInvocations).toContain("line=4");
    expect(mutationInvocations).toContain("/comments/20/replies");
    await expect(
      github.getPullRequest("ArcaneArts/Cantrip", "/missing/worktree", 44),
    ).rejects.toThrow();
  });

  it("fetches an exact pull request head without switching the selected worktree", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-checkout-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    const binDirectory = path.join(dataDirectory, "bin");
    const gitLog = path.join(dataDirectory, "git.log");
    await mkdir(repository);
    await mkdir(binDirectory);
    const head = "7".repeat(40);
    const pullRequest = {
      number: 44,
      title: "Checkout pull requests",
      state: "open",
      html_url: "https://github.com/ArcaneArts/Cantrip/pull/44",
      user: { login: "author" },
      comments: 0,
      labels: [],
      created_at: "2026-08-10T12:00:00.000Z",
      updated_at: "2026-08-10T13:00:00.000Z",
      closed_at: null,
      body: "Checkout this.",
      draft: false,
      merged: false,
      head: { ref: "feature/checkout", sha: head },
      base: { ref: "main", sha: "8".repeat(40) },
    };
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        `process.stdout.write(${JSON.stringify(JSON.stringify(pullRequest))});`,
      ].join("\n"),
    );
    const fakeGit = path.join(binDirectory, "git");
    await writeFile(
      fakeGit,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(gitLog)};`,
        'const args = process.argv.slice(2); fs.appendFileSync(log, args.join("\\0") + "\\n");',
        "if (args.includes('--git-dir')) process.stdout.write('.git\\n');",
        "else if (args.at(-1) === 'remote') process.stdout.write('upstream\\norigin\\n');",
        "else if (args.includes('get-url') && args.at(-1) === 'origin') process.stdout.write('git@github.com:ArcaneArts/Cantrip.git\\n');",
        "else if (args.includes('get-url')) process.stdout.write('https://github.com/someone/fork.git\\n');",
        `else if (args.includes('FETCH_HEAD^{commit}')) process.stdout.write(${JSON.stringify(`${head}\n`)});`,
      ].join("\n"),
    );
    await Promise.all([chmod(fakeGh, 0o755), chmod(fakeGit, 0o755)]);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;

    const prepared = await new GithubClient(
      dataDirectory,
    ).preparePullRequestCheckout("ArcaneArts/Cantrip", repository, 44);
    expect(prepared).toMatchObject({
      branch: "cantrip/pr/44-feature-checkout-77777777",
      headSha: head,
      remote: "origin",
      pullRequest: { number: 44 },
    });
    const invocations = await readFile(gitLog, "utf8");
    expect(invocations).toContain(
      [
        "-C",
        repository,
        "fetch",
        "--no-tags",
        "origin",
        "refs/pull/44/head",
      ].join("\0"),
    );
    expect(invocations).not.toContain("\0checkout\0");
    expect(invocations).not.toContain("\0switch\0");
  });

  it("previews and safely applies pull request lifecycle actions", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-pr-lifecycle-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "feature/lifecycle", repository]);
    const statePath = path.join(dataDirectory, "state.json");
    const logPath = path.join(dataDirectory, "gh.log");
    const originalHead = "5".repeat(40);
    const initialState = {
      state: "open",
      draft: false,
      merged: false,
      mergeable: true,
      head: originalHead,
      base: "6".repeat(40),
    };
    await writeFile(statePath, JSON.stringify(initialState));
    const binDirectory = path.join(dataDirectory, "bin");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const statePath = ${JSON.stringify(statePath)};`,
        `const logPath = ${JSON.stringify(logPath)};`,
        'const args = process.argv.slice(2); fs.appendFileSync(logPath, args.join("\\0") + "\\n");',
        "let state = JSON.parse(fs.readFileSync(statePath, 'utf8'));",
        "const save = () => fs.writeFileSync(statePath, JSON.stringify(state));",
        "const pr = () => ({ number: 44, title: 'Lifecycle', state: state.state, html_url: 'https://github.com/ArcaneArts/Cantrip/pull/44', user: { login: 'author' }, comments: 0, labels: [], created_at: '2026-08-10T12:00:00.000Z', updated_at: '2026-08-10T13:00:00.000Z', closed_at: state.state === 'closed' ? '2026-08-10T14:00:00.000Z' : null, body: 'Lifecycle', draft: state.draft, merged: state.merged, head: { ref: 'feature/lifecycle', sha: state.head }, base: { ref: 'main', sha: state.base }, requested_reviewers: [], mergeable: state.mergeable, mergeable_state: state.mergeable ? 'clean' : 'blocked', additions: 1, deletions: 0, changed_files: 0, commits: 0 });",
        "if (args[0] === 'pr' && args[1] === 'ready') { state.draft = false; save(); process.exit(0); }",
        "const route = args[1] || ''; const methodIndex = args.indexOf('--method'); const method = methodIndex >= 0 ? args[methodIndex + 1] : 'GET';",
        "if (route.endsWith('/pulls/44/merge')) { state.state = 'closed'; state.merged = true; save(); process.stdout.write(JSON.stringify({ merged: true, sha: state.head, message: 'Merged' })); }",
        "else if (route.endsWith('/pulls/44') && method === 'PATCH') { const next = args.find((arg) => arg.startsWith('state=')); state.state = next?.slice(6) || state.state; save(); process.stdout.write(JSON.stringify(pr())); }",
        "else if (route.endsWith('/pulls/44')) process.stdout.write(JSON.stringify(pr()));",
        "else if (route.endsWith('/check-runs')) process.stdout.write(JSON.stringify({ total_count: 0, check_runs: [] }));",
        "else if (route.endsWith('/status')) process.stdout.write(JSON.stringify({ statuses: [] }));",
        "else process.stdout.write('[]');",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = `${binDirectory}:${originalPath ?? ""}`;
    const github = new GithubClient(dataDirectory);

    const closePreview = await github.previewPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      { type: "close" },
    );
    expect(closePreview).toMatchObject({
      destructive: true,
      confirmationPhrase: "close #44",
      headSha: originalHead,
    });
    await expect(
      github.applyPullRequestLifecycle("ArcaneArts/Cantrip", repository, 44, {
        action: { type: "close" },
        token: closePreview.token,
        confirmation: "wrong",
      }),
    ).rejects.toThrow("Type close #44");
    await expect(
      github.applyPullRequestLifecycle("ArcaneArts/Cantrip", repository, 44, {
        action: { type: "close" },
        token: closePreview.token,
        confirmation: "close #44",
      }),
    ).resolves.toMatchObject({ state: "closed", merged: false });

    const reopenPreview = await github.previewPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      { type: "reopen" },
    );
    await github.applyPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      {
        action: { type: "reopen" },
        token: reopenPreview.token,
        confirmation: "",
      },
    );

    await writeFile(
      statePath,
      JSON.stringify({ ...initialState, draft: true }),
    );
    const readyPreview = await github.previewPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      { type: "mark-ready" },
    );
    await expect(
      github.applyPullRequestLifecycle("ArcaneArts/Cantrip", repository, 44, {
        action: { type: "mark-ready" },
        token: readyPreview.token,
        confirmation: "",
      }),
    ).resolves.toMatchObject({ draft: false });

    const mergeAction = {
      type: "merge" as const,
      method: "squash" as const,
      commitTitle: "feat: lifecycle",
      commitMessage: null,
    };
    const staleMergePreview = await github.previewPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      mergeAction,
    );
    await writeFile(
      statePath,
      JSON.stringify({ ...initialState, head: "7".repeat(40) }),
    );
    await expect(
      github.applyPullRequestLifecycle("ArcaneArts/Cantrip", repository, 44, {
        action: mergeAction,
        token: staleMergePreview.token,
        confirmation: "squash #44",
      }),
    ).rejects.toThrow("no longer matches this preview");
    const mergePreview = await github.previewPullRequestLifecycle(
      "ArcaneArts/Cantrip",
      repository,
      44,
      mergeAction,
    );
    await expect(
      github.applyPullRequestLifecycle("ArcaneArts/Cantrip", repository, 44, {
        action: mergeAction,
        token: mergePreview.token,
        confirmation: "squash #44",
      }),
    ).resolves.toMatchObject({ state: "closed", merged: true });
    const invocations = await readFile(logPath, "utf8");
    expect(invocations).toContain("state=closed");
    expect(invocations).toContain("state=open");
    expect(invocations).toContain(
      ["pr", "ready", "44", "--repo", "ArcaneArts/Cantrip"].join("\0"),
    );
    expect(invocations).toContain("merge_method=squash");
    expect(invocations).toContain(`sha=${"7".repeat(40)}`);
    expect(invocations).toContain("commit_title=feat: lifecycle");
  });

  it("targets an existing local release tag or HEAD for a new tag", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-release-create-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(dataDirectory, "repository");
    await execFileAsync("git", ["init", "-b", "main", repository]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.name",
      "Cantrip Test",
    ]);
    await execFileAsync("git", [
      "-C",
      repository,
      "config",
      "user.email",
      "test@cantrip.art",
    ]);
    await writeFile(path.join(repository, "README.md"), "First release\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "First release",
    ]);
    const taggedHead = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();
    await execFileAsync("git", ["-C", repository, "tag", "v1.0.0"]);
    await writeFile(path.join(repository, "README.md"), "Second release\n");
    await execFileAsync("git", ["-C", repository, "add", "."]);
    await execFileAsync("git", [
      "-C",
      repository,
      "commit",
      "-m",
      "Second release",
    ]);
    const currentHead = (
      await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"])
    ).stdout.trim();

    const binDirectory = path.join(dataDirectory, "bin");
    const logPath = path.join(dataDirectory, "gh.log");
    await mkdir(binDirectory);
    const fakeGh = path.join(binDirectory, "gh");
    await writeFile(
      fakeGh,
      [
        "#!/usr/bin/env node",
        'const fs = require("node:fs");',
        `const log = ${JSON.stringify(logPath)};`,
        "const args = process.argv.slice(2);",
        'fs.appendFileSync(log, args.join("\\0") + "\\n");',
        'const field = (name) => args.find((value) => value.startsWith(name + "="))?.slice(name.length + 1) ?? "";',
        'const tag = field("tag_name");',
        "process.stdout.write(JSON.stringify({",
        "  id: 42,",
        "  tag_name: tag,",
        '  name: field("name") || tag,',
        '  body: field("body"),',
        "  html_url: `https://github.com/ArcaneArts/Cantrip/releases/tag/${tag}`,",
        '  author: { login: "cantrip-test" },',
        '  draft: field("draft") === "true",',
        '  prerelease: field("prerelease") === "true",',
        '  created_at: "2026-08-11T12:00:00.000Z",',
        "  published_at: null,",
        "}));",
      ].join("\n"),
    );
    await chmod(fakeGh, 0o755);
    process.env.PATH = [binDirectory, originalPath ?? ""].join(path.delimiter);

    const github = new GithubClient(dataDirectory);
    await expect(
      github.createRelease("ArcaneArts/Cantrip", repository, {
        tagName: "v1.0.0",
        name: "Version 1",
        body: "Existing local tag",
        draft: true,
        prerelease: false,
      }),
    ).resolves.toMatchObject({ tagName: "v1.0.0", name: "Version 1" });
    await expect(
      github.createRelease("ArcaneArts/Cantrip", repository, {
        tagName: "v2.0.0",
        name: "Version 2",
        body: "New tag at HEAD",
        draft: false,
        prerelease: false,
      }),
    ).resolves.toMatchObject({ tagName: "v2.0.0", name: "Version 2" });

    const invocations = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(
      invocations.find((invocation) => invocation.includes("tag_name=v1.0.0")),
    ).toContain(`target_commitish=${taggedHead}`);
    expect(
      invocations.find((invocation) => invocation.includes("tag_name=v2.0.0")),
    ).toContain(`target_commitish=${currentHead}`);
  });

  it("restores the last repository list for the same GitHub login", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-cache-test-"),
    );
    directories.push(dataDirectory);
    const cacheDirectory = path.join(dataDirectory, "github");
    await mkdir(cacheDirectory, { recursive: true });
    await writeFile(
      path.join(cacheDirectory, "repositories.json"),
      JSON.stringify({
        login: "cantrip-test",
        updatedAt: "2026-08-07T12:00:00.000Z",
        repositories: [
          {
            id: "repository-1",
            name: "Cantrip",
            nameWithOwner: "ArcaneArts/Cantrip",
            description: "Cached repository",
            isPrivate: true,
            isFork: false,
            url: "https://github.com/ArcaneArts/Cantrip",
            defaultBranch: "main",
            updatedAt: "2026-08-07T12:00:00.000Z",
          },
        ],
      }),
    );

    const github = new GithubClient(dataDirectory);
    await expect(github.cachedRepositories("cantrip-test")).resolves.toEqual([
      expect.objectContaining({ nameWithOwner: "ArcaneArts/Cantrip" }),
    ]);
    await expect(github.cachedRepositories("another-user")).resolves.toEqual(
      [],
    );
  });

  it("only deletes repositories inside the managed repository root", async () => {
    const dataDirectory = await mkdtemp(
      path.join(tmpdir(), "cantrip-github-test-"),
    );
    directories.push(dataDirectory);
    const repository = path.join(
      dataDirectory,
      "repositories",
      "ArcaneArts",
      "Cantrip",
    );
    const outside = path.join(dataDirectory, "outside");
    await mkdir(repository, { recursive: true });
    await mkdir(outside);
    await writeFile(path.join(repository, "README.md"), "Cantrip\n");

    const github = new GithubClient(dataDirectory);
    await expect(github.deleteRepository(outside)).rejects.toThrow(
      "only delete repositories it manages",
    );
    await expect(github.deleteRepository(repository)).resolves.toEqual({
      deleted: true,
    });
    await expect(github.deleteRepository(repository)).resolves.toEqual({
      deleted: false,
    });
  });
});
