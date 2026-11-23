import type {
  ProjectWorktreeSummary,
  WorkerCommand,
  WorkerWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import { ProjectWorktreeCoordinator } from "../src/worktrees/coordinator.js";

const timestamp = "2026-08-08T17:00:00.000Z";
const primary: WorkerWorktreeSummary = {
  path: "/repositories/cantrip",
  head: "1".repeat(40),
  branch: "main",
  detached: false,
  isPrimary: true,
  managed: true,
  locked: false,
  lockReason: null,
  prunable: false,
  pruneReason: null,
  missing: false,
};

const primaryProjectWorktree: ProjectWorktreeSummary = {
  id: "primary-1",
  projectSourceId: "source-1",
  projectId: "project-1",
  workerId: "worker-1",
  name: "Primary",
  path: primary.path,
  displayPath: primary.path,
  isPrimary: true,
  isDefault: true,
  origin: "cantrip",
  lifecycleState: "ready",
  branch: primary.branch,
  head: primary.head,
  detached: primary.detached,
  locked: primary.locked,
  lockReason: primary.lockReason,
  lastScannedAt: timestamp,
  createdAt: timestamp,
  updatedAt: timestamp,
};

function projectWorktree(
  id: string,
  created: WorkerWorktreeSummary,
  origin: ProjectWorktreeSummary["origin"],
): ProjectWorktreeSummary {
  return {
    id,
    projectSourceId: "source-1",
    projectId: "project-1",
    workerId: "worker-1",
    name: "Review worktree",
    path: created.path,
    displayPath: created.path,
    isPrimary: false,
    isDefault: false,
    origin,
    lifecycleState: "ready",
    branch: created.branch,
    head: created.head,
    detached: created.detached,
    locked: created.locked,
    lockReason: created.lockReason,
    lastScannedAt: timestamp,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

describe("project worktree coordinator", () => {
  it("uses an explicit identity while leaving path selection to the worker", async () => {
    const commands: WorkerCommand[] = [];
    const reconciliations: Array<{
      id: string;
      lifecycleState?: ProjectWorktreeSummary["lifecycleState"];
      name: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    }> = [];
    const created: WorkerWorktreeSummary = {
      ...primary,
      path: "/worker-owned/worktrees/review-abc123",
      branch: "review/inspect",
      isPrimary: false,
    };
    const repository = {
      async getProjectSource() {
        return {
          cwd: primary.path,
          workerId: "worker-1",
          worktreeId: "primary-1",
        };
      },
      async reconcileProjectWorktrees(
        _ownerId: string,
        _projectId: string,
        _workerId: string,
        _inventory: unknown,
        hint?: {
          id: string;
          lifecycleState?: ProjectWorktreeSummary["lifecycleState"];
          name: string;
          origin: ProjectWorktreeSummary["origin"];
          path: string;
        },
      ) {
        if (!hint) return [];
        reconciliations.push(hint);
        return [projectWorktree(hint.id, created, hint.origin)];
      },
    } as unknown as ServerRepository;
    const bridge = {
      async request(_workerId: string, command: WorkerCommand) {
        commands.push(command);
        return {
          created: true,
          worktree: created,
          inventory: {
            sourcePath: primary.path,
            primaryPath: primary.path,
            gitCommonDir: `${primary.path}/.git`,
            managedRoot: "/worker-owned/worktrees",
            repositoryFingerprint: "a".repeat(64),
            worktrees: [primary, created],
          },
        };
      },
    } as unknown as WorkerCommandBus;
    const changedProjects: string[] = [];
    const coordinator = new ProjectWorktreeCoordinator(
      repository,
      bridge,
      (projectId) => changedProjects.push(projectId),
    );

    await expect(
      coordinator.create("owner-1", "project-1", {
        worktreeId: "review-worktree-1",
        name: "Review worktree",
        origin: "cantrip",
        mode: {
          type: "newBranch",
          branch: "review/inspect",
          startPoint: "1".repeat(40),
        },
      }),
    ).resolves.toMatchObject({
      id: "review-worktree-1",
      path: "/worker-owned/worktrees/review-abc123",
      lifecycleState: "ready",
    });
    expect(commands).toEqual([
      expect.objectContaining({
        type: "worktree.create",
        sourcePath: primary.path,
        worktreeId: "review-worktree-1",
      }),
    ]);
    expect(reconciliations).toEqual([
      {
        id: "review-worktree-1",
        lifecycleState: "ready",
        name: "Review worktree",
        origin: "cantrip",
        path: "/worker-owned/worktrees/review-abc123",
      },
    ]);
    expect(changedProjects).toEqual(["project-1"]);
  });

  it("creates from the explicitly selected project source", async () => {
    const selectedSourcePath = "/replicas/worker-two/cantrip";
    const created: WorkerWorktreeSummary = {
      ...primary,
      path: "/replicas/worker-two/worktrees/review",
      branch: "review",
      isPrimary: false,
    };
    const getProjectSource = vi.fn();
    const repository = {
      getProjectSource,
      async getProjectWorktreeContext() {
        return {
          sourcePath: selectedSourcePath,
          workerId: "worker-2",
        };
      },
      async reconcileProjectWorktrees() {
        return [
          {
            ...primaryProjectWorktree,
            id: "review-worktree",
            projectSourceId: "source-2",
            workerId: "worker-2",
            name: "Review",
            path: created.path,
            displayPath: created.path,
            isPrimary: false,
            isDefault: false,
            branch: created.branch,
            head: created.head,
          },
        ];
      },
    } as unknown as ServerRepository;
    const commands: Array<{ workerId: string; command: WorkerCommand }> = [];
    const bridge = {
      async request(workerId: string, command: WorkerCommand) {
        commands.push({ workerId, command });
        return {
          created: true,
          worktree: created,
          inventory: {
            sourcePath: selectedSourcePath,
            primaryPath: selectedSourcePath,
            gitCommonDir: `${selectedSourcePath}/.git`,
            managedRoot: "/replicas/worker-two/worktrees",
            repositoryFingerprint: "b".repeat(64),
            worktrees: [{ ...primary, path: selectedSourcePath }, created],
          },
        };
      },
    } as unknown as WorkerCommandBus;
    const coordinator = new ProjectWorktreeCoordinator(repository, bridge);

    await coordinator.create("owner-1", "project-1", {
      sourceWorktreeId: "selected-worktree",
      worktreeId: "review-worktree",
      name: "Review",
      origin: "user",
      mode: { type: "existingBranch", branch: "review" },
    });

    expect(getProjectSource).not.toHaveBeenCalled();
    expect(commands).toEqual([
      {
        workerId: "worker-2",
        command: expect.objectContaining({
          type: "worktree.create",
          sourcePath: selectedSourcePath,
          worktreeId: "review-worktree",
        }),
      },
    ]);
  });

  it("rolls back a newly created physical worktree when reconciliation fails", async () => {
    const created: WorkerWorktreeSummary = {
      ...primary,
      path: "/worker-owned/worktrees/agent-rollback",
      branch: "codex/agent-rollback",
      isPrimary: false,
    };
    let physicalWorktreeExists = false;
    const rollbackCatalog = vi.fn().mockResolvedValue(true);
    const repository = {
      async getProjectSource() {
        return {
          cwd: primary.path,
          workerId: "worker-1",
          worktreeId: "primary-1",
        };
      },
      async reconcileProjectWorktrees() {
        throw new Error("induced database failure");
      },
      rollbackProjectWorktreeCreation: rollbackCatalog,
    } as unknown as ServerRepository;
    const commands: WorkerCommand[] = [];
    const bridge = {
      async request(_workerId: string, command: WorkerCommand) {
        commands.push(command);
        if (command.type === "worktree.create") {
          physicalWorktreeExists = true;
          return {
            created: true,
            worktree: created,
            inventory: {
              sourcePath: primary.path,
              primaryPath: primary.path,
              gitCommonDir: `${primary.path}/.git`,
              managedRoot: "/worker-owned/worktrees",
              repositoryFingerprint: "a".repeat(64),
              worktrees: [primary, created],
            },
          };
        }
        if (command.type === "worktree.remove") {
          expect(command).toMatchObject({
            worktreePath: created.path,
            force: false,
            allowExternal: false,
          });
          physicalWorktreeExists = false;
          return {
            removedPath: created.path,
            inventory: {
              sourcePath: primary.path,
              primaryPath: primary.path,
              gitCommonDir: `${primary.path}/.git`,
              managedRoot: "/worker-owned/worktrees",
              repositoryFingerprint: "a".repeat(64),
              worktrees: [primary],
            },
          };
        }
        throw new Error(`Unexpected command ${command.type}.`);
      },
    } as unknown as WorkerCommandBus;
    const coordinator = new ProjectWorktreeCoordinator(repository, bridge);

    await expect(
      coordinator.create("owner-1", "project-1", {
        worktreeId: "agent-rollback-1",
        name: "Agent rollback",
        origin: "agent",
        mode: {
          type: "newBranch",
          branch: "codex/agent-rollback",
          startPoint: primary.head,
        },
      }),
    ).rejects.toMatchObject({
      failure: {
        code: "worktree-create-rolled-back",
        mutation: {
          outcome: "rolledBack",
          retryable: true,
          target: {
            kind: "worktree",
            projectId: "project-1",
            worktreeId: "agent-rollback-1",
          },
        },
      },
    });
    expect(physicalWorktreeExists).toBe(false);
    expect(commands.map(({ type }) => type)).toEqual([
      "worktree.create",
      "worktree.remove",
    ]);
    expect(rollbackCatalog).toHaveBeenCalledWith(
      "owner-1",
      "project-1",
      "worker-1",
      {
        id: "agent-rollback-1",
        origin: "agent",
        path: created.path,
      },
    );
  });

  it("serializes a project without poisoning its queue after failure", async () => {
    const coordinator = new ProjectWorktreeCoordinator(
      {} as never,
      {} as never,
    );
    const order: string[] = [];
    let releaseFirst!: () => void;
    const first = coordinator.serialize("project-1", async () => {
      order.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first:end");
      throw new Error("expected failure");
    });
    const second = coordinator.serialize("project-1", async () => {
      order.push("second");
    });
    const independent = coordinator.serialize("project-2", async () => {
      order.push("independent");
    });

    await independent;
    expect(order).toEqual(["first:start", "independent"]);
    releaseFirst();
    await expect(first).rejects.toThrow("expected failure");
    await second;
    expect(order).toEqual([
      "first:start",
      "independent",
      "first:end",
      "second",
    ]);
  });

  it("serializes read-only work without publishing a project change", async () => {
    const changedProjects: string[] = [];
    const coordinator = new ProjectWorktreeCoordinator(
      {} as never,
      {} as never,
      (projectId) => changedProjects.push(projectId),
    );

    await coordinator.serialize("project-1", async () => "read", {
      notifyProjectChanged: false,
    });
    expect(changedProjects).toEqual([]);

    await coordinator.serialize("project-1", async () => "write");
    expect(changedProjects).toEqual(["project-1"]);
  });
});
