import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { GithubClient } from "../src/github.js";
import { ProjectReplicaPlacementManager } from "../src/project-replica-placement.js";
import { deriveManagedRepositoryTarget } from "../src/project-workspace-storage.js";

const exec = promisify(execFile);
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(kind: "system" | "managed" = "managed") {
  const directory = await mkdtemp(path.join(tmpdir(), "cantrip-link-repair-"));
  directories.push(directory);
  const dataDirectory = path.join(directory, "worker");
  const storage =
    kind === "managed"
      ? ({ kind, workspaceId: randomUUID() } as const)
      : ({ kind } as const);
  const canonical = deriveManagedRepositoryTarget(
    dataDirectory,
    storage,
    "fixture",
    "link",
  );
  const remote = path.join(directory, "remotes", "fixture", "link.git");
  const seed = path.join(directory, "seed");
  const linkPath = path.join(directory, "external", "link");
  await mkdir(path.dirname(remote), { recursive: true });
  await exec("git", ["init", "--bare", "--initial-branch=main", remote]);
  await exec("git", ["init", "--initial-branch=main", seed]);
  await writeFile(path.join(seed, "README.md"), "workspace link fixture\n");
  await exec("git", ["-C", seed, "add", "README.md"]);
  await exec("git", [
    "-C",
    seed,
    "-c",
    "user.name=QA",
    "-c",
    "user.email=qa@example.test",
    "commit",
    "-m",
    "Fixture",
  ]);
  await exec("git", ["-C", seed, "push", remote, "main"]);
  await mkdir(path.dirname(canonical), { recursive: true });
  await exec("git", ["clone", remote, canonical]);
  const github = new GithubClient(dataDirectory, "link-worker");
  const provision = {
    jobId: randomUUID(),
    projectId: randomUUID(),
    attempt: 1,
    nameWithOwner: "fixture/link",
    expectedRevision: null,
    workspaceStorage: storage,
    placement: { mode: "managed-link" as const, path: linkPath },
  };
  const result = await github.provisionReplica(provision);
  expect(result.status, JSON.stringify(result)).toBe("ready");
  if (result.status !== "ready" || !result.placement?.linkPath) {
    throw new Error("Fixture provisioning failed.");
  }
  expect(await realpath(linkPath)).toBe(result.path);
  await rm(linkPath);
  const request = {
    projectId: provision.projectId,
    nameWithOwner: provision.nameWithOwner,
    sourcePath: result.path,
    linkPath: result.placement.linkPath,
    repositoryFingerprint: result.repositoryFingerprint,
  };
  return {
    directory,
    dataDirectory,
    storage,
    github,
    request,
    provision,
    result,
  };
}

describe("managed-link repair using workspace-derived storage", () => {
  it("rejects a changed repository origin before recreating the link", async () => {
    const { github, request } = await fixture();
    await exec("git", [
      "-C",
      request.sourcePath,
      "remote",
      "set-url",
      "origin",
      "https://github.com/unrelated/link.git",
    ]);
    await expect(github.repairReplicaLink(request)).resolves.toMatchObject({
      status: "blocked",
      error: { code: "target-mismatch" },
    });
    await expect(lstat(request.linkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it.each(["system", "managed"] as const)(
    "repairs and replays the original missing link in %s storage",
    async (kind) => {
      const { github, request } = await fixture(kind);
      await expect(github.repairReplicaLink(request)).resolves.toMatchObject({
        status: "ready",
        repaired: true,
        path: request.sourcePath,
      });
      expect((await lstat(request.linkPath)).isSymbolicLink()).toBe(true);
      expect(await realpath(request.linkPath)).toBe(request.sourcePath);
      expect(
        await readFile(path.join(request.linkPath, "README.md"), "utf8"),
      ).toBe("workspace link fixture\n");
      await expect(github.repairReplicaLink(request)).resolves.toMatchObject({
        status: "ready",
        repaired: false,
      });
    },
  );

  it.each([
    "missing claim",
    "released claim",
    "different project",
    "different worker",
    "changed fingerprint",
  ] as const)("rejects %s without recreating the link", async (fault) => {
    const { github, request, dataDirectory } = await fixture();
    let client = github;
    if (fault === "missing claim")
      await rm(path.join(dataDirectory, "project-replica-placements.json"));
    if (fault === "released claim") {
      await new ProjectReplicaPlacementManager(
        dataDirectory,
        "link-worker",
      ).releasePlacement({
        canonicalPath: request.sourcePath,
        gitCommonDir: null,
        mode: "managed-link",
        ownership: "cantrip",
        projectId: request.projectId,
        repositoryFingerprint: request.repositoryFingerprint,
      });
    }
    if (fault === "different project") request.projectId = randomUUID();
    if (fault === "different worker")
      client = new GithubClient(dataDirectory, "another-worker");
    if (fault === "changed fingerprint")
      request.repositoryFingerprint = "0".repeat(64);
    await expect(client.repairReplicaLink(request)).resolves.toMatchObject({
      status: "blocked",
      error: { code: "ownership-proof-missing" },
    });
    await expect(lstat(request.linkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(
      await readFile(path.join(request.sourcePath, "README.md"), "utf8"),
    ).toBe("workspace link fixture\n");
  });

  it.each(["file", "retargeted link"] as const)(
    "preserves an occupied %s",
    async (fault) => {
      const { directory, github, request } = await fixture();
      const other = path.join(directory, "unrelated");
      if (fault === "file")
        await writeFile(request.linkPath, "preserve this\n");
      else {
        await mkdir(other);
        await symlink(
          other,
          request.linkPath,
          process.platform === "win32" ? "junction" : "dir",
        );
      }
      await expect(github.repairReplicaLink(request)).resolves.toMatchObject({
        status: "blocked",
        error: { code: "link-target-mismatch" },
      });
      if (fault === "file")
        expect(await readFile(request.linkPath, "utf8")).toBe(
          "preserve this\n",
        );
      else expect(await realpath(request.linkPath)).toBe(await realpath(other));
    },
  );

  it.each([
    "outside storage",
    "invalid workspace",
    "wrong repository location",
    "workspace symlink escape",
  ] as const)("rejects %s even with a matching Git origin", async (fault) => {
    const { directory, dataDirectory, storage, github, request } =
      await fixture();
    let destination: string;
    if (fault === "workspace symlink escape") {
      if (storage.kind !== "managed")
        throw new Error("Expected managed workspace.");
      const workspaceRoot = path.join(
        dataDirectory,
        "workspaces",
        storage.workspaceId,
      );
      destination = path.join(directory, "outside-workspace");
      await rename(workspaceRoot, destination);
      await symlink(
        destination,
        workspaceRoot,
        process.platform === "win32" ? "junction" : "dir",
      );
    } else {
      destination =
        fault === "outside storage"
          ? path.join(directory, "outside", "fixture", "link")
          : path.join(
              dataDirectory,
              "workspaces",
              fault === "invalid workspace" ? "not-a-uuid" : randomUUID(),
              "repositories",
              "fixture",
              fault === "wrong repository location" ? "another-name" : "link",
            );
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(request.sourcePath, destination);
      request.sourcePath = destination;
    }
    const gitCommonDir = await realpath(
      path.join(await realpath(request.sourcePath), ".git"),
    );
    request.repositoryFingerprint = createHash("sha256")
      .update(gitCommonDir)
      .digest("hex");
    await expect(github.repairReplicaLink(request)).resolves.toMatchObject({
      status: "blocked",
      error: { code: "target-mismatch" },
    });
    await expect(lstat(request.linkPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});
