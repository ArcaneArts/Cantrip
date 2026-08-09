import { createHash, randomUUID } from "node:crypto";

import {
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  worktreeRemoveResultSchema,
  worktreeStatusResultSchema,
  type ProjectWorktreeSummary,
  type WorktreeCreateMode,
} from "@cantrip/protocol";
import type {
  WorkflowRunDetail,
  WorkflowWorktreeLease,
  WorkflowWorktreeOutcomeRequest,
} from "@cantrip/protocol/workflows";

import type { ServerRepository } from "../db/repository.js";
import { WorkflowControlConflictError } from "../db/workflow-runs.js";
import {
  type WorkerCommandBus,
  WorkerUnavailableError,
} from "../workers/bridge.js";

type WorktreeRepository = Pick<
  ServerRepository,
  | "getProjectSource"
  | "getProjectWorktreeContext"
  | "observeProjectWorktree"
  | "reconcileProjectWorktrees"
  | "workflowRuns"
>;

export interface ProjectWorktreeCreateRequest {
  mode: WorktreeCreateMode;
  name: string;
  origin: ProjectWorktreeSummary["origin"];
  worktreeId?: string;
}

export interface WorkflowWorktreeAllocationRequest {
  runId: string;
  runNodeId: string;
  runNodeItemId: string | null;
}

export interface WorkflowWorktreeAllocation {
  lease: WorkflowWorktreeLease;
  worktree: ProjectWorktreeSummary;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function workflowLaneIdentity(
  input: WorkflowWorktreeAllocationRequest,
): {
  branchName: string;
  name: string;
} {
  const unitId = input.runNodeItemId ?? input.runNodeId;
  const label = unitId
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 32);
  const identity = createHash("sha256")
    .update(`${input.runId}\0${input.runNodeId}\0${input.runNodeItemId ?? ""}`)
    .digest("hex")
    .slice(0, 16);
  return {
    branchName: `cantrip/workflow/${label || "unit"}-${identity}`,
    name: `Workflow ${label || "unit"} ${identity}`,
  };
}

/**
 * Serializes worker-owned Git worktree mutations for one logical project and
 * reconciles every worker result back into the server-owned worktree catalog.
 * Callers provide identity and intent; the worker remains authoritative for
 * filesystem paths and Git state.
 */
export class ProjectWorktreeCoordinator {
  readonly #mutationQueues = new Map<string, Promise<void>>();

  constructor(
    private readonly repository: WorktreeRepository,
    private readonly bridge: WorkerCommandBus,
  ) {}

  async serialize<T>(
    projectId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.#mutationQueues.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationQueues.set(projectId, settled);
    try {
      return await current;
    } finally {
      if (this.#mutationQueues.get(projectId) === settled) {
        this.#mutationQueues.delete(projectId);
      }
    }
  }

  async create(
    ownerId: string,
    projectId: string,
    input: ProjectWorktreeCreateRequest,
  ): Promise<ProjectWorktreeSummary | null> {
    return this.serialize(projectId, () =>
      this.createInProject(ownerId, projectId, input),
    );
  }

  async allocateWorkflowLane(
    ownerId: string,
    projectId: string,
    input: WorkflowWorktreeAllocationRequest,
  ): Promise<WorkflowWorktreeAllocation | null> {
    return this.serialize(projectId, async () => {
      const identity = workflowLaneIdentity(input);
      const detail = await this.repository.workflowRuns.getRun(
        ownerId,
        input.runId,
      );
      if (!detail || detail.run.projectId !== projectId) return null;
      let lease = detail.worktreeLeases.find(
        (candidate) =>
          candidate.runNodeId === input.runNodeId &&
          candidate.runNodeItemId === input.runNodeItemId &&
          candidate.state !== "released",
      );
      if (lease && lease.branchName !== identity.branchName) {
        throw new Error(
          "The workflow execution unit already reserved a different branch.",
        );
      }

      const source = await this.repository.getProjectSource(ownerId, projectId);
      if (!source) return null;
      const primaryContext = await this.repository.getProjectWorktreeContext(
        ownerId,
        projectId,
        source.worktreeId,
      );
      if (!primaryContext || !primaryContext.worktree.isPrimary) {
        throw new Error("The workflow project has no valid Primary worktree.");
      }

      if (!lease) {
        const primary = await this.inspectWorktree(
          ownerId,
          projectId,
          primaryContext,
        );
        if (
          primary.lifecycleState !== "ready" ||
          !primary.isPrimary ||
          !primary.head
        ) {
          throw new Error(
            "The workflow project Primary is not ready for lane allocation.",
          );
        }
        const reservation =
          await this.repository.workflowRuns.reserveWorktreeLease(ownerId, {
            runId: input.runId,
            runNodeId: input.runNodeId,
            runNodeItemId: input.runNodeItemId,
            projectSourceId: primary.projectSourceId,
            workerId: primary.workerId,
            branchName: identity.branchName,
            baseRevision: primary.head,
          });
        if (!reservation) return null;
        lease = reservation.lease;
      }

      if (
        !lease.projectSourceId ||
        !lease.workerId ||
        !lease.branchName ||
        !lease.baseRevision ||
        lease.projectSourceId !== primaryContext.projectSourceId ||
        lease.workerId !== primaryContext.workerId
      ) {
        throw new Error(
          "The workflow worktree reservation no longer matches its project source.",
        );
      }
      if (lease.state === "active") {
        if (!lease.worktreeId) {
          throw new Error(
            "The active workflow worktree lease has no worktree.",
          );
        }
        const context = await this.repository.getProjectWorktreeContext(
          ownerId,
          projectId,
          lease.worktreeId,
        );
        if (
          !context ||
          context.projectSourceId !== lease.projectSourceId ||
          context.workerId !== lease.workerId ||
          context.worktree.isPrimary
        ) {
          throw new Error(
            "The active workflow worktree lease no longer matches its lane.",
          );
        }
        const worktree = await this.inspectWorktree(
          ownerId,
          projectId,
          context,
        );
        if (
          worktree.lifecycleState !== "ready" ||
          worktree.branch !== lease.branchName
        ) {
          throw new Error("The active workflow worktree lane is not ready.");
        }
        return { lease, worktree };
      }
      if (!["allocating", "recovering"].includes(lease.state)) {
        throw new Error(
          `A ${lease.state} workflow worktree lease cannot be allocated.`,
        );
      }

      try {
        const created = await this.createInProject(ownerId, projectId, {
          worktreeId: lease.requestedWorktreeId,
          name: identity.name,
          origin: "cantrip",
          mode: {
            type: "newBranch",
            branch: lease.branchName,
            startPoint: lease.baseRevision,
          },
        });
        if (!created) return null;
        const context = await this.repository.getProjectWorktreeContext(
          ownerId,
          projectId,
          created.id,
        );
        if (!context) {
          throw new Error("The created workflow worktree is unavailable.");
        }
        const inspected = worktreeStatusResultSchema.parse(
          await this.bridge.request(context.workerId, {
            type: "worktree.status",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
          }),
        );
        const worktree = await this.repository.observeProjectWorktree(
          ownerId,
          projectId,
          created.id,
          inspected.worktree,
        );
        if (
          !worktree ||
          worktree.isPrimary ||
          worktree.lifecycleState !== "ready" ||
          worktree.projectSourceId !== lease.projectSourceId ||
          worktree.workerId !== lease.workerId ||
          worktree.branch !== lease.branchName ||
          worktree.head !== lease.baseRevision ||
          inspected.status.head !== lease.baseRevision ||
          inspected.status.files.length > 0
        ) {
          throw new Error(
            "The created workflow worktree did not match its clean reservation.",
          );
        }
        const activated =
          await this.repository.workflowRuns.activateWorktreeLease(
            ownerId,
            lease.id,
            {
              worktreeId: worktree.id,
              startingRevision: lease.baseRevision,
            },
          );
        if (!activated) {
          throw new Error(
            "The workflow worktree lease could not be activated.",
          );
        }
        return { lease: activated, worktree };
      } catch (error) {
        await this.repository.workflowRuns.failWorktreeLeaseAllocation(
          ownerId,
          lease.id,
          {
            code:
              error instanceof WorkerUnavailableError
                ? "worker-unavailable"
                : "worktree-allocation-failed",
            message: error instanceof Error ? error.message : String(error),
            recoverable: error instanceof WorkerUnavailableError,
          },
        );
        throw error;
      }
    });
  }

  async resolveWorkflowLane(
    ownerId: string,
    runId: string,
    leaseId: string,
    input: WorkflowWorktreeOutcomeRequest,
  ): Promise<WorkflowRunDetail | null> {
    const initial = await this.repository.workflowRuns.getRun(ownerId, runId);
    if (!initial) return null;
    if (!initial.run.projectId) {
      throw new WorkflowControlConflictError(
        "The workflow run has no project worktree to resolve.",
      );
    }
    const projectId = initial.run.projectId;
    return this.serialize(projectId, async () => {
      const preflight =
        await this.repository.workflowRuns.preflightWorktreeLeaseOutcome(
          ownerId,
          runId,
          leaseId,
          input,
        );
      if (!preflight) return null;
      if (preflight.replayed) {
        return this.repository.workflowRuns.getRun(ownerId, runId);
      }
      if (input.action === "keep") {
        await this.repository.workflowRuns.resolveWorktreeLeaseOutcome(
          ownerId,
          runId,
          leaseId,
          input,
          false,
        );
        return this.repository.workflowRuns.getRun(ownerId, runId);
      }

      const lease = preflight.lease;
      const context = await this.repository.getProjectWorktreeContext(
        ownerId,
        projectId,
        lease.worktreeId!,
      );
      if (
        !context ||
        context.projectSourceId !== lease.projectSourceId ||
        context.workerId !== lease.workerId ||
        context.worktree.isPrimary ||
        context.worktree.origin !== "cantrip"
      ) {
        throw new WorkflowControlConflictError(
          "The checkpointed workflow worktree no longer matches its managed lane.",
        );
      }
      const inspected = worktreeStatusResultSchema.parse(
        await this.bridge.request(context.workerId, {
          type: "worktree.status",
          sourcePath: context.sourcePath,
          worktreePath: context.worktree.path,
        }),
      );
      const observed = await this.repository.observeProjectWorktree(
        ownerId,
        projectId,
        context.worktree.id,
        inspected.worktree,
      );
      const producedChanges = {
        git: {
          branch: inspected.status.branch,
          head: inspected.status.head,
          upstream: inspected.status.upstream,
          ahead: inspected.status.ahead,
          behind: inspected.status.behind,
          files: inspected.status.files,
        },
      };
      if (
        !observed ||
        observed.isPrimary ||
        observed.lifecycleState !== "ready" ||
        observed.locked ||
        !inspected.worktree.managed ||
        observed.branch !== lease.branchName ||
        inspected.status.head !== lease.endingRevision ||
        inspected.worktree.head !== lease.endingRevision ||
        inspected.status.files.length > 0 !== lease.worktreeDirty ||
        canonicalJson(producedChanges) !== canonicalJson(lease.producedChanges)
      ) {
        throw new WorkflowControlConflictError(
          "The workflow worktree changed after its checkpoint; keep it and inspect the drift before resolving it.",
        );
      }

      let worktreeRemoved = false;
      if (input.action === "discard") {
        const result = worktreeRemoveResultSchema.parse(
          await this.bridge.request(context.workerId, {
            type: "worktree.remove",
            sourcePath: context.sourcePath,
            worktreePath: context.worktree.path,
            force: true,
            allowExternal: false,
          }),
        );
        if (
          result.removedPath !== context.worktree.path ||
          result.inventory.worktrees.some(
            ({ path }) => path === context.worktree.path,
          )
        ) {
          throw new Error(
            "The worker did not confirm removal of the discarded workflow lane.",
          );
        }
        await this.repository.reconcileProjectWorktrees(
          ownerId,
          projectId,
          result.inventory,
        );
        worktreeRemoved = true;
      }
      await this.repository.workflowRuns.resolveWorktreeLeaseOutcome(
        ownerId,
        runId,
        leaseId,
        input,
        worktreeRemoved,
      );
      return this.repository.workflowRuns.getRun(ownerId, runId);
    });
  }

  async reconcile(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[] | null> {
    return this.serialize(projectId, async () => {
      const source = await this.repository.getProjectSource(ownerId, projectId);
      if (!source) return null;
      const inventory = worktreeInventorySchema.parse(
        await this.bridge.request(source.workerId, {
          type: "worktree.reconcile",
          sourcePath: source.cwd,
        }),
      );
      return this.repository.reconcileProjectWorktrees(
        ownerId,
        projectId,
        inventory,
      );
    });
  }

  private async createInProject(
    ownerId: string,
    projectId: string,
    input: ProjectWorktreeCreateRequest,
  ): Promise<ProjectWorktreeSummary | null> {
    const source = await this.repository.getProjectSource(ownerId, projectId);
    if (!source) return null;
    const worktreeId = input.worktreeId ?? randomUUID();
    const result = worktreeCreateResultSchema.parse(
      await this.bridge.request(source.workerId, {
        type: "worktree.create",
        sourcePath: source.cwd,
        worktreeId,
        name: input.name,
        mode: input.mode,
      }),
    );
    const reconciled = await this.repository.reconcileProjectWorktrees(
      ownerId,
      projectId,
      result.inventory,
      {
        id: worktreeId,
        name: input.name,
        origin: input.origin,
        path: result.worktree.path,
      },
    );
    const created = reconciled?.find(({ id }) => id === worktreeId);
    if (!created) {
      throw new Error("Created worktree could not be reconciled.");
    }
    return created;
  }

  private async inspectWorktree(
    ownerId: string,
    projectId: string,
    context: NonNullable<
      Awaited<ReturnType<ServerRepository["getProjectWorktreeContext"]>>
    >,
  ): Promise<ProjectWorktreeSummary> {
    const result = worktreeStatusResultSchema.parse(
      await this.bridge.request(context.workerId, {
        type: "worktree.status",
        sourcePath: context.sourcePath,
        worktreePath: context.worktree.path,
      }),
    );
    if (result.status.head !== result.worktree.head) {
      throw new Error("Worker Git status disagreed with its worktree head.");
    }
    const observed = await this.repository.observeProjectWorktree(
      ownerId,
      projectId,
      context.worktree.id,
      result.worktree,
    );
    if (!observed) {
      throw new Error("The inspected project worktree could not be observed.");
    }
    return observed;
  }
}
