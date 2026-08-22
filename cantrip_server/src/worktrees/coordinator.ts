import { createHash, randomUUID } from "node:crypto";

import {
  RUN_CONFIGURATION_CANONICAL_PATH,
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestCheckoutResultSchema,
  worktreeCreateMutationFailureSchema,
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  worktreeRemoveResultSchema,
  worktreeStatusResultSchema,
  runConfigurationInspectionSchema,
  type ProjectWorktreeSummary,
  type GithubPullRequestCheckoutResult,
  type WorktreeCreateMutationFailure,
  type WorktreeCreateMutationOutcome,
  type WorktreeCreateMode,
  type WorktreeCreateResult,
} from "@cantrip/protocol";
import type {
  WorkflowRunWireDetail,
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
  | "listProjectWorktrees"
  | "observeProjectWorktree"
  | "reconcileProjectWorktrees"
  | "rollbackProjectWorktreeCreation"
  | "workflowRuns"
  | "worktreeSetupJobs"
>;

export interface ProjectWorktreeCreateRequest {
  mode: WorktreeCreateMode;
  name: string;
  origin: ProjectWorktreeSummary["origin"];
  worktreeId?: string;
}

class WorktreeSetupPendingError extends Error {}

export class WorktreeCreateMutationError extends Error {
  readonly failure: WorktreeCreateMutationFailure;

  constructor(
    outcome: WorktreeCreateMutationOutcome,
    projectId: string,
    worktreeId: string | null,
    message: string,
    retryable: boolean,
    options?: { cause?: unknown },
  ) {
    const recoverySuffix = worktreeId
      ? ` Recovery target: project ${projectId}, worktree ${worktreeId}.`
      : "";
    const boundedMessage = `${message}${recoverySuffix}`.slice(0, 2_000);
    super(boundedMessage, options);
    this.name = "WorktreeCreateMutationError";
    this.failure = worktreeCreateMutationFailureSchema.parse({
      code: `worktree-create-${
        outcome === "notStarted"
          ? "not-started"
          : outcome === "rolledBack"
            ? "rolled-back"
            : outcome
      }`,
      error: boundedMessage,
      mutation: {
        outcome,
        retryable,
        target: worktreeId ? { kind: "worktree", projectId, worktreeId } : null,
      },
    });
  }
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
    private readonly onProjectChanged?: (projectId: string) => void,
    private readonly onSetupQueued?: () => void,
  ) {}

  async serialize<T>(
    projectId: string,
    operation: () => Promise<T>,
    options: { notifyProjectChanged?: boolean } = {},
  ): Promise<T> {
    const previous = this.#mutationQueues.get(projectId) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const settled = current.then(
      () => undefined,
      () => undefined,
    );
    this.#mutationQueues.set(projectId, settled);
    try {
      const result = await current;
      if (options.notifyProjectChanged ?? true) {
        this.notifyProjectChanged(projectId);
      }
      return result;
    } finally {
      if (this.#mutationQueues.get(projectId) === settled) {
        this.#mutationQueues.delete(projectId);
      }
    }
  }

  notifyProjectChanged(projectId: string): void {
    this.onProjectChanged?.(projectId);
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

  async checkoutPullRequest(
    ownerId: string,
    projectId: string,
    sourceWorktreeId: string,
    repository: string,
    pullRequestNumber: number,
  ): Promise<GithubPullRequestCheckoutResult | null> {
    return this.serialize(projectId, async () => {
      const context = await this.repository.getProjectWorktreeContext(
        ownerId,
        projectId,
        sourceWorktreeId,
      );
      if (!context) return null;
      if (context.worktree.lifecycleState !== "ready") {
        throw new Error("The selected worktree is not ready.");
      }
      const prepared = githubPullRequestCheckoutPreparedSchema.parse(
        await this.bridge.request(context.workerId, {
          type: "github.pull-request.checkout.prepare",
          cwd: context.worktree.path,
          repository,
          number: pullRequestNumber,
        }),
      );
      const existing = (
        await this.repository.listProjectWorktrees(ownerId, projectId)
      ).find(({ branch }) => branch === prepared.branch);
      if (existing) {
        if (
          existing.lifecycleState !== "ready" ||
          existing.head !== prepared.headSha ||
          existing.workerId !== context.workerId
        ) {
          throw new Error(
            `The checkout branch ${prepared.branch} already belongs to a different or unavailable worktree.`,
          );
        }
        return githubPullRequestCheckoutResultSchema.parse({
          pullRequest: prepared.pullRequest,
          worktree: existing,
          reused: true,
        });
      }
      const worktree = await this.createInProject(ownerId, projectId, {
        name: prepared.name,
        origin: "user",
        mode: {
          type: "newBranch",
          branch: prepared.branch,
          startPoint: prepared.headSha,
        },
      });
      if (!worktree) return null;
      return githubPullRequestCheckoutResultSchema.parse({
        pullRequest: prepared.pullRequest,
        worktree,
        reused: false,
      });
    });
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
        const existing = await this.repository.getProjectWorktreeContext(
          ownerId,
          projectId,
          lease.requestedWorktreeId,
          { allowSetupStates: true },
        );
        if (
          existing &&
          (existing.projectSourceId !== lease.projectSourceId ||
            existing.workerId !== lease.workerId ||
            existing.worktree.isPrimary ||
            existing.worktree.branch !== lease.branchName)
        ) {
          throw new Error(
            "The reserved workflow worktree identity belongs to another lane.",
          );
        }
        const created =
          existing?.worktree ??
          (await this.createInProject(ownerId, projectId, {
            worktreeId: lease.requestedWorktreeId,
            name: identity.name,
            origin: "cantrip",
            mode: {
              type: "newBranch",
              branch: lease.branchName,
              startPoint: lease.baseRevision,
            },
          }));
        if (!created) return null;
        if (created.lifecycleState === "preparing") {
          throw new WorktreeSetupPendingError(
            "The workflow worktree is still running its project setup.",
          );
        }
        if (created.lifecycleState !== "ready") {
          throw new Error(
            `The workflow worktree cannot activate while setup is ${created.lifecycleState}.`,
          );
        }
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
            recoverable:
              error instanceof WorkerUnavailableError ||
              error instanceof WorktreeSetupPendingError,
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
  ): Promise<WorkflowRunWireDetail | null> {
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
      if (lease.state === "recovering" && input.action === "discard") {
        const inventory = worktreeInventorySchema.parse(
          await this.bridge.request(context.workerId, {
            type: "worktree.reconcile",
            sourcePath: context.sourcePath,
          }),
        );
        await this.repository.reconcileProjectWorktrees(
          ownerId,
          projectId,
          context.workerId,
          inventory,
        );
        if (
          !inventory.worktrees.some(
            ({ path }) => path === context.worktree.path,
          )
        ) {
          await this.repository.workflowRuns.resolveWorktreeLeaseOutcome(
            ownerId,
            runId,
            leaseId,
            input,
            true,
          );
          return this.repository.workflowRuns.getRun(ownerId, runId);
        }
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
      const started =
        await this.repository.workflowRuns.beginWorktreeLeaseOutcome(
          ownerId,
          runId,
          leaseId,
          input,
        );
      if (!started) return null;
      if (started.state !== "recovering") {
        return this.repository.workflowRuns.getRun(ownerId, runId);
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
          context.workerId,
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
        source.workerId,
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
    if (!source) {
      throw new WorktreeCreateMutationError(
        "notStarted",
        projectId,
        null,
        "Project source not found; worktree creation did not start.",
        false,
      );
    }
    const worktreeId = input.worktreeId ?? randomUUID();
    let result: WorktreeCreateResult;
    try {
      result = worktreeCreateResultSchema.parse(
        await this.bridge.request(source.workerId, {
          type: "worktree.create",
          sourcePath: source.cwd,
          worktreeId,
          name: input.name,
          mode: input.mode,
        }),
      );
    } catch (error) {
      throw new WorktreeCreateMutationError(
        "partial",
        projectId,
        worktreeId,
        "The worker did not confirm whether worktree creation completed. Reconcile the exact recovery target before retrying.",
        true,
        { cause: error },
      );
    }
    let created: ProjectWorktreeSummary;
    try {
      const reconciled = await this.repository.reconcileProjectWorktrees(
        ownerId,
        projectId,
        source.workerId,
        result.inventory,
        {
          id: worktreeId,
          lifecycleState: "preparing",
          name: input.name,
          origin: input.origin,
          path: result.worktree.path,
        },
      );
      const candidate = reconciled?.find(({ id }) => id === worktreeId);
      if (!candidate) {
        throw new Error("Created worktree could not be reconciled.");
      }
      created = candidate;
    } catch (error) {
      throw await this.rollbackUncommittedCreate({
        cause: error,
        createdByRequest: result.created,
        input,
        ownerId,
        projectId,
        sourcePath: source.cwd,
        workerId: source.workerId,
        worktreeId,
        worktreePath: result.worktree.path,
      });
    }
    let configurationRevision: string | null = null;
    let setupQueued = false;
    let configurationError: {
      code: "configuration-invalid" | "setup-start-failed";
      message: string;
      retryable: true;
    } | null = null;
    try {
      const inspection = runConfigurationInspectionSchema.parse(
        await this.bridge.request(source.workerId, {
          type: "project.run-configurations.inspect",
          sourcePath: source.cwd,
        }),
      );
      const configuration = inspection.configurations.find(
        ({ relativePath }) => relativePath === RUN_CONFIGURATION_CANONICAL_PATH,
      );
      configurationRevision = configuration?.revision ?? null;
      configurationError = inspection.valid
        ? null
        : {
            code: "configuration-invalid",
            message:
              "The project environment is invalid. Validate it before retrying worktree setup.",
            retryable: true,
          };
      setupQueued = !configurationError && Boolean(configuration?.setup);
    } catch {
      configurationError = {
        code: "setup-start-failed",
        message:
          "Cantrip could not inspect the project environment after creating the worktree. Retry setup when the worker is available.",
        retryable: true,
      };
    }
    try {
      const initialized = await this.repository.worktreeSetupJobs.initialize({
        configurationRevision,
        ...(configurationError ? { error: configurationError } : {}),
        ownerId,
        projectId,
        queued: setupQueued,
        workerId: source.workerId,
        worktreeId,
      });
      if (initialized.job.state === "queued") this.onSetupQueued?.();
      return {
        ...created,
        lifecycleState:
          initialized.job.state === "queued"
            ? "preparing"
            : initialized.job.state === "failed"
              ? "setup-failed"
              : "ready",
        updatedAt: initialized.job.updatedAt,
      };
    } catch (error) {
      throw new WorktreeCreateMutationError(
        "committed",
        projectId,
        worktreeId,
        "Worktree creation committed, but setup bookkeeping did not finish. Reconcile the exact target instead of creating another worktree.",
        true,
        { cause: error },
      );
    }
  }

  private async rollbackUncommittedCreate(input: {
    cause: unknown;
    createdByRequest: boolean;
    input: ProjectWorktreeCreateRequest;
    ownerId: string;
    projectId: string;
    sourcePath: string;
    workerId: string;
    worktreeId: string;
    worktreePath: string;
  }): Promise<WorktreeCreateMutationError> {
    if (
      !input.createdByRequest ||
      (input.input.origin !== "agent" && input.input.origin !== "cantrip")
    ) {
      return new WorktreeCreateMutationError(
        "partial",
        input.projectId,
        input.worktreeId,
        "A preexisting or user-owned worktree could not be reconciled and was left untouched. Reconcile the exact recovery target before retrying.",
        true,
        { cause: input.cause },
      );
    }
    try {
      const removed = worktreeRemoveResultSchema.parse(
        await this.bridge.request(input.workerId, {
          type: "worktree.remove",
          sourcePath: input.sourcePath,
          worktreePath: input.worktreePath,
          force: false,
          allowExternal: false,
        }),
      );
      if (
        removed.removedPath !== input.worktreePath ||
        removed.inventory.worktrees.some(
          ({ path }) => path === input.worktreePath,
        )
      ) {
        throw new Error("Worker removal did not match the created worktree.");
      }
      const catalogRolledBack =
        await this.repository.rollbackProjectWorktreeCreation(
          input.ownerId,
          input.projectId,
          input.workerId,
          {
            id: input.worktreeId,
            origin: input.input.origin,
            path: input.worktreePath,
          },
        );
      if (!catalogRolledBack) {
        throw new Error("The exact worktree catalog row could not be removed.");
      }
      return new WorktreeCreateMutationError(
        "rolledBack",
        input.projectId,
        input.worktreeId,
        "Worktree reconciliation failed, and the newly created worktree was rolled back. Retrying is safe.",
        true,
        { cause: input.cause },
      );
    } catch (rollbackError) {
      return new WorktreeCreateMutationError(
        "partial",
        input.projectId,
        input.worktreeId,
        "Worktree reconciliation failed, and automatic rollback could not be verified. Reconcile the exact recovery target before retrying.",
        true,
        { cause: rollbackError },
      );
    }
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
