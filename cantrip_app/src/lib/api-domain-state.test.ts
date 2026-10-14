import { beforeEach, describe, expect, it, vi } from "vitest";

const ports = vi.hoisted(() => ({
  workers: vi.fn(),
  worktrees: vi.fn(),
  repositoryGrant: vi.fn(),
  runGrant: vi.fn(),
  server: "http://first.invalid",
  owner: "first-owner",
}));
vi.mock("./api/worker-wire", async (original) => ({
  ...(await original<typeof import("./api/worker-wire")>()),
  getWorkers: ports.workers,
}));
vi.mock("./api/projects", async (original) => ({
  ...(await original<typeof import("./api/projects")>()),
  getProjectWorktreeWireList: ports.worktrees,
}));
vi.mock("./repository-worker-encryption", () => ({
  ensureRepositoryWorkerEncryption: ports.repositoryGrant,
}));
vi.mock("./endpoint-content-worker-encryption", () => ({
  ensureEndpointContentWorkerEncryption: ports.runGrant,
}));
vi.mock("./server-connections", async (original) => ({
  ...(await original<typeof import("./server-connections")>()),
  getActiveServerUrl: () => ports.server,
}));
vi.mock("./client-session", async (original) => ({
  ...(await original<typeof import("./client-session")>()),
  getClientSession: () => ({ user: { id: ports.owner } }),
}));

import {
  CantripApiError,
  getProjectWorktreeStatus,
  ensureRunOperationWorker,
} from "./api";
import { ensureRunOperationWorker as ensureRunDirect } from "./api/repository-operations";

function target() {
  return {
    projectId: crypto.randomUUID(),
    worker: {
      workerId: crypto.randomUUID(),
      encryption: {
        principalId: crypto.randomUUID(),
        state: "ready",
        grants: [
          { component: "run-content", keyRevision: 1 },
          { component: "repository-content", keyRevision: 1 },
        ],
      },
    },
    worktree: {
      id: crypto.randomUUID(),
      workerId: "",
      isPrimary: true,
      isDefault: true,
      lifecycleState: "ready",
    },
  };
}
beforeEach(() => {
  ports.workers.mockReset();
  ports.worktrees.mockReset();
  ports.repositoryGrant.mockReset();
  ports.runGrant.mockReset().mockResolvedValue(undefined);
  ports.server = "http://first.invalid";
  ports.owner = "first-owner";
});

describe("API domain shared target ownership", () => {
  it("coalesces worktree and Run metadata while keeping component authorization failures separate", async () => {
    const selected = target();
    selected.worktree.workerId = selected.worker.workerId;
    let resolve!: (value: unknown[]) => void;
    ports.worktrees.mockImplementation(
      () =>
        new Promise<unknown[]>((done) => {
          resolve = done;
        }),
    );
    ports.workers.mockResolvedValue([selected.worker]);
    const failure = new Error("repository component denied");
    ports.repositoryGrant.mockRejectedValue(failure);
    const settled = Promise.allSettled([
      getProjectWorktreeStatus(selected.projectId, selected.worktree.id),
      ensureRunDirect({
        projectId: selected.projectId,
        worktreeId: selected.worktree.id,
      }),
    ]);
    await vi.waitFor(() => expect(ports.worktrees).toHaveBeenCalledTimes(1));
    resolve([selected.worktree]);
    const [repository, run] = await settled;
    expect(repository).toEqual({ status: "rejected", reason: failure });
    expect(run).toEqual({
      status: "fulfilled",
      value: { worker: selected.worker, worktree: selected.worktree },
    });
    expect(ports.workers).toHaveBeenCalledTimes(1);
    expect(ports.repositoryGrant).toHaveBeenCalledTimes(1);
    expect(ports.runGrant).toHaveBeenCalledTimes(1);
    expect(ports.runGrant).toHaveBeenCalledWith({
      domains: ["run-content"],
      worker: selected.worker,
    });
  });

  it("resolves fresh metadata and grants after server or owner replacement through either import path", async () => {
    const selected = target();
    selected.worktree.workerId = selected.worker.workerId;
    ports.worktrees.mockResolvedValue([selected.worktree]);
    ports.workers.mockResolvedValue([selected.worker]);
    const input = {
      projectId: selected.projectId,
      worktreeId: selected.worktree.id,
    };
    await ensureRunOperationWorker(input);
    await ensureRunDirect(input);
    expect(ports.worktrees).toHaveBeenCalledTimes(1);
    expect(ports.runGrant).toHaveBeenCalledTimes(1);
    ports.server = "http://replacement.invalid";
    await ensureRunDirect(input);
    ports.owner = "replacement-owner";
    await ensureRunOperationWorker(input);
    expect(ports.worktrees).toHaveBeenCalledTimes(3);
    expect(ports.workers).toHaveBeenCalledTimes(3);
    expect(ports.runGrant).toHaveBeenCalledTimes(3);
  });

  it("preserves compatible API errors and evicts failed target discovery before another domain retries", async () => {
    const selected = target();
    selected.worktree.workerId = selected.worker.workerId;
    ports.workers.mockResolvedValue([selected.worker]);
    ports.worktrees
      .mockResolvedValueOnce([
        { ...selected.worktree, lifecycleState: "removed" },
      ])
      .mockResolvedValue([selected.worktree]);
    const failed = getProjectWorktreeStatus(
      selected.projectId,
      selected.worktree.id,
    );
    await expect(failed).rejects.toBeInstanceOf(CantripApiError);
    await expect(failed).rejects.toMatchObject({ status: 409 });
    await expect(
      ensureRunDirect({
        projectId: selected.projectId,
        worktreeId: selected.worktree.id,
      }),
    ).resolves.toMatchObject({ worktree: selected.worktree });
    expect(ports.worktrees).toHaveBeenCalledTimes(2);
    expect(ports.repositoryGrant).not.toHaveBeenCalled();
  });
});
