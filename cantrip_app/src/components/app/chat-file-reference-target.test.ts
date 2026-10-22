import type { ProjectSummary, ProjectWorktreeSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { resolveChatFileReferenceTarget } from "./chat-file-reference-target";

const projectId = "project-1";
const taskRoot = "/Cantrip/.cantrip/worker/worktrees/project/qualification";
function worktree(
  id: string,
  path: string,
  overrides: Partial<ProjectWorktreeSummary> = {},
): ProjectWorktreeSummary {
  return {
    id,
    projectId,
    projectSourceId: "source-1",
    workerId: "worker-1",
    path,
    displayPath: path,
    isPrimary: id === "primary",
    lifecycleState: "ready",
    ...overrides,
  } as ProjectWorktreeSummary;
}
const primary = worktree("primary", "/Obelisk");
const task = worktree("task", taskRoot);
function resolve(
  reference: string,
  overrides: Partial<Parameters<typeof resolveChatFileReferenceTarget>[0]> = {},
) {
  return resolveChatFileReferenceTarget({
    reference,
    projectId,
    activeWorktreeId: primary.id,
    source: null,
    worktrees: [primary, task],
    refreshWorktrees: vi.fn().mockResolvedValue([]),
    ...overrides,
  });
}

describe("chat file reference target", () => {
  it("opens an absolute task-worktree link in that checkout while the chat is on Primary", async () => {
    const refreshWorktrees = vi.fn();
    await expect(
      resolve(`${taskRoot}/docs/BASELINE.md:42`, { refreshWorktrees }),
    ).resolves.toEqual({
      path: "docs/BASELINE.md",
      worktreeId: task.id,
    });
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });

  it.each(["Protected path unavailable", "/old/qualification"])(
    "hydrates all project worktrees when the cached path is %s",
    async (path) => {
      const refreshWorktrees = vi.fn().mockResolvedValue([primary, task]);
      await expect(
        resolve(`${taskRoot}/README.md`, {
          worktrees: [primary, worktree("task", path)],
          refreshWorktrees,
        }),
      ).resolves.toEqual({ path: "README.md", worktreeId: task.id });
      expect(refreshWorktrees).toHaveBeenCalledOnce();
    },
  );

  it("refreshes inventory when the task checkout is not cached yet", async () => {
    await expect(
      resolve(`${taskRoot}/README.md`, {
        worktrees: [primary],
        refreshWorktrees: vi.fn().mockResolvedValue([primary, task]),
      }),
    ).resolves.toEqual({ path: "README.md", worktreeId: task.id });
  });

  it("prefers the most specific registered root over a parent checkout", async () => {
    await expect(
      resolve(`${taskRoot}/src/app.ts`, {
        worktrees: [worktree("parent", "/Cantrip"), task],
      }),
    ).resolves.toEqual({ path: "src/app.ts", worktreeId: task.id });
  });

  it("keeps relative links bound to their original message checkout, even if it was removed", async () => {
    const refreshWorktrees = vi.fn();
    await expect(
      resolve("docs/README.md:14", {
        messageWorktreeId: "original-checkout",
        worktrees: [primary],
        refreshWorktrees,
      }),
    ).resolves.toEqual({
      path: "docs/README.md",
      worktreeId: "original-checkout",
    });
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });

  it("uses the active checkout for legacy relative links without hydrating protected paths", async () => {
    const refreshWorktrees = vi.fn();
    await expect(
      resolve("docs/README.md:14", {
        worktrees: [],
        refreshWorktrees,
      }),
    ).resolves.toEqual({ path: "docs/README.md", worktreeId: primary.id });
    expect(refreshWorktrees).not.toHaveBeenCalled();
  });

  it("maps a source path alias to that source's Primary, not the active secondary", async () => {
    await expect(
      resolve("/linked-project/README.md", {
        activeWorktreeId: task.id,
        source: {
          id: "source-1",
          workerId: "worker-1",
          path: "/linked-project",
          displayPath: "/linked-project",
        } as ProjectSummary["source"],
      }),
    ).resolves.toEqual({ path: "README.md", worktreeId: primary.id });
  });

  it("recognizes Windows file URLs and display-path aliases", async () => {
    await expect(
      resolve("file:///C:/Projects/Task/src/app.ts#L12", {
        worktrees: [
          worktree("windows", "D:\\canonical", {
            displayPath: "c:\\projects\\task",
          }),
        ],
      }),
    ).resolves.toEqual({ path: "src/app.ts", worktreeId: "windows" });
  });

  it("uses message provenance to disambiguate identical paths on different workers", async () => {
    await expect(
      resolve("/project/README.md", {
        messageWorktreeId: "remote",
        worktrees: [
          worktree("primary", "/project"),
          worktree("remote", "/project", { workerId: "worker-2" }),
        ],
      }),
    ).resolves.toEqual({ path: "README.md", worktreeId: "remote" });
  });

  it("rejects ambiguous roots rather than picking an arbitrary worker", async () => {
    await expect(
      resolve("/shared/README.md", {
        worktrees: [
          worktree("one", "/shared"),
          worktree("two", "/shared", { workerId: "worker-2" }),
        ],
      }),
    ).resolves.toBeNull();
  });

  it.each([
    "/other/README.md",
    "/Obelisk-other/README.md",
    "/Obelisk/../../secrets",
    "../secrets",
    "https://example.com/README.md",
  ])("does not strip an unrecognized or unsafe root: %s", async (reference) => {
    await expect(
      resolve(reference, {
        refreshWorktrees: vi.fn().mockResolvedValue([primary, task]),
      }),
    ).resolves.toBeNull();
  });

  it("never selects another project's worktree", async () => {
    const foreign = worktree("foreign", "/other-project", {
      projectId: "project-2",
    });
    await expect(
      resolve("/other-project/README.md", {
        worktrees: [foreign],
        refreshWorktrees: vi.fn().mockResolvedValue([foreign]),
      }),
    ).resolves.toBeNull();
  });

  it("propagates an actual refresh failure", async () => {
    await expect(
      resolve("/unknown/README.md", {
        refreshWorktrees: vi
          .fn()
          .mockRejectedValue(new Error("Worker is offline")),
      }),
    ).rejects.toThrow("Worker is offline");
  });
});
