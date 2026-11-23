import { randomUUID } from "node:crypto";

import {
  githubPullRequestCheckoutPreparedSchema,
  githubPullRequestCheckoutResultSchema,
  worktreeCreateMutationFailureSchema,
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  worktreeRemoveResultSchema,
  type ProjectWorktreeSummary,
  type GithubPullRequestCheckoutResult,
  type WorktreeCreateMutationFailure,
  type WorktreeCreateMutationOutcome,
  type WorktreeCreateMode,
  type WorktreeCreateResult,
} from "@cantrip/protocol";
import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

type WorktreeRepository = Pick<
  ServerRepository,
  | "getProjectSource"
  | "getProjectWorktreeContext"
  | "listProjectWorktrees"
  | "observeProjectWorktree"
  | "reconcileProjectWorktrees"
  | "rollbackProjectWorktreeCreation"
>;

export interface ProjectWorktreeCreateRequest {
  mode: WorktreeCreateMode;
  name: string;
  origin: ProjectWorktreeSummary["origin"];
  sourceWorktreeId?: string;
  worktreeId?: string;
}

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

  async reconcile(
    ownerId: string,
    projectId: string,
  ): Promise<ProjectWorktreeSummary[] | null> {
    return this.serialize(projectId, async () => {
      const source = await this.repository.getProjectSource(
        ownerId,
        projectId,
        {
          isWorkerAvailable: (workerId) => this.bridge.isConnected(workerId),
        },
      );
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
    const requestedSource = input.sourceWorktreeId
      ? await this.repository.getProjectWorktreeContext(
          ownerId,
          projectId,
          input.sourceWorktreeId,
        )
      : null;
    const source = requestedSource
      ? {
          cwd: requestedSource.sourcePath,
          workerId: requestedSource.workerId,
        }
      : input.sourceWorktreeId
        ? null
        : await this.repository.getProjectSource(ownerId, projectId, {
            isWorkerAvailable: (workerId) => this.bridge.isConnected(workerId),
          });
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
          lifecycleState: "ready",
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
    return created;
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
}
