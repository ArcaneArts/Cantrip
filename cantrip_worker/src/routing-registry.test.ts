import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { managedFolderMaterializeReadySchema } from "@cantrip/protocol";

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
    const protectedRepair = (await registry.protectResult(
      "project.replica.link.repair",
      {
        status: "ready",
        projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb349",
        path: "/Users/example/private-repository",
        linkPath: "/Users/example/private-link",
        repaired: true,
      },
    )) as { path: string; linkPath: string };
    expect(protectedRepair.path).toMatch(/^ctrr_/u);
    expect(protectedRepair.linkPath).toMatch(/^ctrr_/u);
    const protectedScratch = (await registry.protectResult(
      "chat.scratch.provision",
      {
        rootId: "33333333-3333-4333-8333-333333333333",
        chatId: "22222222-2222-4222-8222-222222222222",
        path: "/Users/example/worker-data/chat-scratch/chat-id",
        displayPath: "chat-scratch/chat-id",
      },
    )) as { path: string; displayPath: string };
    expect(protectedScratch.path).toMatch(/^ctrr_/u);
    expect(protectedScratch.displayPath).toMatch(/^ctrr_/u);
    const protectedDiscovery = (await registry.protectResult(
      "workspace.repositories.discover",
      {
        candidates: [
          {
            path: "/Users/example/private-repository",
            displayPath: "private-repository",
            originUrl: "git@github.com:ArcaneArts/Private.git",
            github: {
              repositoryId: "private-repository-id",
              nameWithOwner: "ArcaneArts/Private",
              url: "https://github.com/ArcaneArts/Private",
            },
            repositoryFingerprint: "a".repeat(64),
            classification: "github-accessible",
            diagnosticCode: null,
          },
        ],
      },
    )) as {
      candidates: Array<{
        path: string;
        displayPath: string;
        originUrl: string;
        github: { repositoryId: string; nameWithOwner: string; url: string };
      }>;
    };
    expect(protectedDiscovery.candidates[0]).toEqual(
      expect.objectContaining({
        path: protectedResult.worktree.path,
        displayPath: expect.stringMatching(/^ctrr_/u),
        originUrl: expect.stringMatching(/^ctrr_/u),
        github: {
          repositoryId: expect.stringMatching(/^ctrr_/u),
          nameWithOwner: expect.stringMatching(/^ctrr_/u),
          url: expect.stringMatching(/^ctrr_/u),
        },
      }),
    );
    expect(JSON.stringify(protectedDiscovery)).not.toContain(
      "ArcaneArts/Private",
    );
    expect(JSON.stringify(protectedDiscovery)).not.toContain(
      "/Users/example/private-repository",
    );
    const protectedObservation = (await registry.protectResult(
      "worktree.observation.configure",
      {
        accepted: true,
        paths: [
          {
            projectId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb349",
            worktreeId: "primary",
            sourcePath: "/Users/example/private-repository",
            worktreePath: "/Users/example/private-repository",
          },
        ],
      },
    )) as { paths: Array<{ sourcePath: string; worktreePath: string }> };
    expect(protectedObservation.paths[0]).toMatchObject({
      sourcePath: protectedResult.worktree.path,
      worktreePath: protectedResult.worktree.path,
    });
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
    const protectedFolder = managedFolderMaterializeReadySchema.parse(
      await registry.protectResult("project.folder.materialize", {
        status: "ready",
        jobId: "019fdcf5-c116-77d0-9588-7c65fc3bc7c2",
        attempt: 1,
        path: "/Users/example/private-repository",
        displayPath: "/Users/example/private-repository",
        reused: true,
        repositoryFingerprint: "a".repeat(64),
        github: {
          repositoryId: "private-repository-id",
          nameWithOwner: "ArcaneArts/Private",
          url: "https://github.com/ArcaneArts/Private",
        },
      }),
    );
    expect(protectedFolder.github).toEqual(protectedIdentity);

    const restarted = new WorkerRoutingRegistry(dataDirectory);
    const command = await restarted.resolveCommand({
      type: "git.status",
      cwd: protectedResult.worktree.path,
    });
    expect(command).toEqual({
      type: "git.status",
      cwd: "/Users/example/private-repository",
    });
    expect(
      await restarted.resolveCommand({
        type: "workspace.repositories.discover",
        jobId: "019fe8aa-a7a3-7404-8a96-d3be7f0fb339",
        attempt: 1,
        rootPath: protectedDiscovery.candidates[0]!.path,
        depth: 3,
      }),
    ).toMatchObject({
      rootPath: "/Users/example/private-repository",
    });
    expect(await restarted.resolveMetadata(protectedIdentity)).toEqual({
      nameWithOwner: "ArcaneArts/Private",
      repositoryId: "private-repository-id",
      url: "https://github.com/ArcaneArts/Private",
    });
    await expect(
      restarted.protectMetadata({ unsupported: "must not pass through" }),
    ).rejects.toThrow("Unsupported repository metadata field.");
    await expect(
      restarted.resolveCommand({
        type: "git.status",
        cwd: `ctrr_${"z".repeat(43)}`,
      }),
    ).rejects.toThrow(
      "Repository routing metadata is unavailable on this worker.",
    );
    await expect(
      restarted.resolveMetadata({
        branch: `refs/heads/ctrr_${"z".repeat(43)}`,
      }),
    ).rejects.toThrow(
      "Repository routing metadata is unavailable on this worker.",
    );
    expect(
      registry.protectError(
        "project.share.open",
        Object.assign(
          new Error("Failed below /Users/example/private-repository"),
          { code: "project-source-unavailable" },
        ),
      ),
    ).toMatchObject({
      code: "project-source-unavailable",
      message: "Protected repository operation failed on the worker.",
    });
  });
});
