import { randomUUID } from "node:crypto";

import {
  worktreeCreateResultSchema,
  worktreeInventorySchema,
  type ProjectWorktreeSummary,
  type WorktreeCreateMode,
} from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

type WorktreeRepository = Pick<
  ServerRepository,
  "getProjectSource" | "reconcileProjectWorktrees"
>;

export interface ProjectWorktreeCreateRequest {
  mode: WorktreeCreateMode;
  name: string;
  origin: ProjectWorktreeSummary["origin"];
  worktreeId?: string;
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
    return this.serialize(projectId, async () => {
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
}
