import type {
  ProjectWorktreeSummary,
  WorkerCommand,
  WorkerWorktreeSummary,
} from "@cantrip/protocol";
import type { WorkflowWorktreeLease } from "@cantrip/protocol/workflows";
import { describe, expect, it } from "vitest";

import type { ServerRepository } from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";
import {
  ProjectWorktreeCoordinator,
  workflowLaneIdentity,
} from "../src/worktrees/coordinator.js";

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

function statusResult(worktree: WorkerWorktreeSummary) {
  return {
    worktree,
    status: {
      branch: worktree.branch ?? "",
      head: worktree.head,
      upstream: null,
      ahead: 0,
      behind: 0,
      files: [],
      branches: [],
    },
  };
}

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
  it("derives stable Git-safe identities for workflow execution units", () => {
    const input = {
      runId: "run/with unsafe ref syntax",
      runNodeId: "node..with spaces",
      runNodeItemId: "item/@{unsafe}",
    };
    const identity = workflowLaneIdentity(input);
    expect(workflowLaneIdentity(input)).toEqual(identity);
    expect(identity).toMatchObject({
      branchName: expect.stringMatching(
        /^cantrip\/workflow\/[a-z0-9-]+-[0-9a-f]{16}$/u,
      ),
      name: expect.stringMatching(/^Workflow [a-z0-9-]+ [0-9a-f]{16}$/u),
    });
    expect(identity.branchName.length).toBeLessThanOrEqual(255);
    expect(
      workflowLaneIdentity({ ...input, runNodeItemId: "different-item" }),
    ).not.toEqual(identity);
  });

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

  it("reserves, verifies, activates, and replays a workflow lane in one project queue", async () => {
    const commands: WorkerCommand[] = [];
    const request = {
      runId: "run-1",
      runNodeId: "node-1",
      runNodeItemId: null,
    };
    const identity = workflowLaneIdentity(request);
    const createdWorkerWorktree: WorkerWorktreeSummary = {
      ...primary,
      path: "/worker-owned/worktrees/workflow-run-1-node-1",
      branch: identity.branchName,
      isPrimary: false,
    };
    const createdProjectWorktree = projectWorktree(
      "workflow-worktree-1",
      createdWorkerWorktree,
      "cantrip",
    );
    let currentLease: WorkflowWorktreeLease | null = null;
    let reservations = 0;
    let activations = 0;
    const failures: Array<{ recoverable: boolean }> = [];
    const repository = {
      workflowRuns: {
        async getRun() {
          return {
            run: { projectId: "project-1" },
            worktreeLeases: currentLease ? [currentLease] : [],
          };
        },
        async reserveWorktreeLease() {
          reservations += 1;
          currentLease = {
            id: "lease-1",
            runId: "run-1",
            runNodeId: "node-1",
            runNodeItemId: null,
            projectSourceId: "source-1",
            workerId: "worker-1",
            requestedWorktreeId: "workflow-worktree-1",
            worktreeId: null,
            leaseKey: "lease-key-1",
            state: "allocating",
            branchName: identity.branchName,
            baseRevision: primary.head,
            startingRevision: null,
            endingRevision: null,
            worktreeDirty: null,
            producedChanges: {},
            errorCode: null,
            errorMessage: null,
            activatedAt: null,
            checkpointedAt: null,
            releasedAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
          };
          return { created: true, lease: currentLease };
        },
        async activateWorktreeLease() {
          activations += 1;
          currentLease = {
            ...currentLease!,
            worktreeId: createdProjectWorktree.id,
            startingRevision: primary.head,
            state: "active",
            activatedAt: timestamp,
          };
          return currentLease;
        },
        async failWorktreeLeaseAllocation(
          _ownerId: string,
          _leaseId: string,
          failure: { recoverable: boolean },
        ) {
          failures.push(failure);
          return currentLease;
        },
      },
      async getProjectSource() {
        return {
          cwd: primary.path,
          workerId: "worker-1",
          worktreeId: primaryProjectWorktree.id,
        };
      },
      async getProjectWorktreeContext(
        _ownerId: string,
        _projectId: string,
        worktreeId: string,
      ) {
        const worktree =
          worktreeId === primaryProjectWorktree.id
            ? primaryProjectWorktree
            : worktreeId === createdProjectWorktree.id
              ? createdProjectWorktree
              : null;
        return worktree
          ? {
              projectId: "project-1",
              projectSourceId: "source-1",
              sourcePath: primary.path,
              workerId: "worker-1",
              worktree,
            }
          : null;
      },
      async observeProjectWorktree(
        _ownerId: string,
        _projectId: string,
        worktreeId: string,
      ) {
        return worktreeId === primaryProjectWorktree.id
          ? primaryProjectWorktree
          : worktreeId === createdProjectWorktree.id
            ? createdProjectWorktree
            : null;
      },
      async reconcileProjectWorktrees(
        _ownerId: string,
        _projectId: string,
        _inventory: unknown,
        hint?: { id: string },
      ) {
        return hint?.id === createdProjectWorktree.id
          ? [primaryProjectWorktree, createdProjectWorktree]
          : [primaryProjectWorktree];
      },
    } as unknown as ServerRepository;
    const bridge = {
      async request(_workerId: string, command: WorkerCommand) {
        commands.push(command);
        if (command.type === "worktree.create") {
          return {
            worktree: createdWorkerWorktree,
            inventory: {
              sourcePath: primary.path,
              primaryPath: primary.path,
              gitCommonDir: `${primary.path}/.git`,
              managedRoot: "/worker-owned/worktrees",
              repositoryFingerprint: "a".repeat(64),
              worktrees: [primary, createdWorkerWorktree],
            },
          };
        }
        if (command.type === "worktree.status") {
          return statusResult(
            command.worktreePath === primary.path
              ? primary
              : createdWorkerWorktree,
          );
        }
        throw new Error(`Unexpected command ${command.type}.`);
      },
    } as unknown as WorkerCommandBus;
    const coordinator = new ProjectWorktreeCoordinator(repository, bridge);

    await expect(
      coordinator.allocateWorkflowLane("owner-1", "project-1", request),
    ).resolves.toMatchObject({
      lease: { id: "lease-1", state: "active" },
      worktree: { id: "workflow-worktree-1", isPrimary: false },
    });
    await expect(
      coordinator.allocateWorkflowLane("owner-1", "project-1", request),
    ).resolves.toMatchObject({
      lease: { id: "lease-1", state: "active" },
      worktree: { id: "workflow-worktree-1" },
    });
    expect(commands.map(({ type }) => type)).toEqual([
      "worktree.status",
      "worktree.create",
      "worktree.status",
      "worktree.status",
    ]);
    expect(commands[1]).toMatchObject({
      type: "worktree.create",
      worktreeId: "workflow-worktree-1",
      name: identity.name,
      mode: {
        type: "newBranch",
        branch: identity.branchName,
        startPoint: primary.head,
      },
    });
    expect({ activations, failures, reservations }).toEqual({
      activations: 1,
      failures: [],
      reservations: 1,
    });
  });
});
