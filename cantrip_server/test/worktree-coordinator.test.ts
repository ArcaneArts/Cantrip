import type {
  ProjectWorktreeSummary,
  WorkerCommand,
  WorkerWorktreeSummary,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

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
    name: "Workflow lane",
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
      name: string;
      origin: ProjectWorktreeSummary["origin"];
      path: string;
    }> = [];
    const created: WorkerWorktreeSummary = {
      ...primary,
      path: "/worker-owned/worktrees/workflow-abc123",
      branch: "cantrip/workflow/run-1/inspect",
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
        _inventory: unknown,
        hint?: {
          id: string;
          name: string;
          origin: ProjectWorktreeSummary["origin"];
          path: string;
        },
      ) {
        if (!hint) return [];
        reconciliations.push(hint);
        return [projectWorktree(hint.id, created, hint.origin)];
      },
    } as unknown as Pick<
      ServerRepository,
      "getProjectSource" | "reconcileProjectWorktrees"
    >;
    const bridge = {
      async request(_workerId: string, command: WorkerCommand) {
        commands.push(command);
        return {
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
    const coordinator = new ProjectWorktreeCoordinator(repository, bridge);

    await expect(
      coordinator.create("owner-1", "project-1", {
        worktreeId: "workflow-worktree-1",
        name: "Workflow lane",
        origin: "cantrip",
        mode: {
          type: "newBranch",
          branch: "cantrip/workflow/run-1/inspect",
          startPoint: "1".repeat(40),
        },
      }),
    ).resolves.toMatchObject({
      id: "workflow-worktree-1",
      path: "/worker-owned/worktrees/workflow-abc123",
    });
    expect(commands).toEqual([
      expect.objectContaining({
        type: "worktree.create",
        sourcePath: primary.path,
        worktreeId: "workflow-worktree-1",
      }),
    ]);
    expect(reconciliations).toEqual([
      {
        id: "workflow-worktree-1",
        name: "Workflow lane",
        origin: "cantrip",
        path: "/worker-owned/worktrees/workflow-abc123",
      },
    ]);
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
});
