import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { WorkerRoutingRegistry } from "./routing-registry.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("WorkerRoutingRegistry", () => {
  it("persists opaque routing tokens and resolves them after restart", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-routing-registry-"),
    );
    temporaryDirectories.push(dataDirectory);
    const registry = new WorkerRoutingRegistry(dataDirectory);
    const protectedResult = (await registry.protectResult("worktree.status", {
      worktree: {
        path: "/Users/example/private-repository",
        branch: "private-feature",
      },
      status: {
        branch: "private-feature",
        files: [{ path: "private/roadmap.md", originalPath: null }],
      },
    })) as {
      worktree: { path: string; branch: string };
      status: { branch: string; files: Array<{ path: string }> };
    };

    expect(protectedResult.worktree.path).toMatch(/^ctrr_/u);
    expect(protectedResult.worktree.branch).toMatch(/^ctrr_/u);
    expect(protectedResult.status.files[0]?.path).toMatch(/^ctrr_/u);
    expect(
      await readFile(
        path.join(dataDirectory, "repository-routing.json"),
        "utf8",
      ),
    ).toContain("/Users/example/private-repository");
    expect(
      (await stat(path.join(dataDirectory, "repository-routing.json"))).mode &
        0o777,
    ).toBe(0o600);

    const protectedIdentity = await registry.protectMetadata({
      nameWithOwner: "ArcaneArts/Private",
      repositoryId: "private-repository-id",
      url: "https://github.com/ArcaneArts/Private",
    });
    expect(protectedIdentity).toEqual({
      nameWithOwner: expect.stringMatching(/^ctrr_/u),
      repositoryId: expect.stringMatching(/^ctrr_/u),
      url: expect.stringMatching(/^ctrr_/u),
    });

    const restarted = new WorkerRoutingRegistry(dataDirectory);
    const command = await restarted.resolveCommand({
      type: "git.status",
      cwd: protectedResult.worktree.path,
    });
    expect(command).toEqual({
      type: "git.status",
      cwd: "/Users/example/private-repository",
    });
    expect(await restarted.resolveMetadata(protectedIdentity)).toEqual({
      nameWithOwner: "ArcaneArts/Private",
      repositoryId: "private-repository-id",
      url: "https://github.com/ArcaneArts/Private",
    });
    await expect(
      restarted.protectMetadata({ unsupported: "must not pass through" }),
    ).rejects.toThrow("Unsupported repository metadata field.");
    expect(
      registry.protectError(
        "worktree.create",
        new Error("Failed below /Users/example/private-repository"),
      ),
    ).toMatchObject({
      message: "Protected repository operation failed on the worker.",
    });
  });
});
