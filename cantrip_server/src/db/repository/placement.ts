import type {
  ExecutionPlacementResolution,
  ExecutionSurfaceKind,
  ExecutionTarget,
} from "@cantrip/protocol";
import { and, asc, eq, isNull } from "drizzle-orm";

import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { WORKER_ONLINE_WINDOW_MS } from "./workers.js";

type WorkerRow = typeof schema.workers.$inferSelect;

export class ExecutionPlacementUnavailableError extends Error {
  constructor(
    readonly code:
      | "capability-unavailable"
      | "no-compatible-placement"
      | "project-not-found"
      | "replica-unavailable"
      | "target-mismatch"
      | "target-not-found"
      | "worker-offline"
      | "worktree-unavailable",
    message: string,
  ) {
    super(message);
  }
}

export class PlacementRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async resolveProjectExecutionPlacement(
    ownerId: string,
    projectId: string,
    surfaceKind: ExecutionSurfaceKind,
    target?: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowOfflineExplicit = false,
  ): Promise<ExecutionPlacementResolution> {
    const projectRows = await this.database
      .select({
        id: schema.projects.id,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
      })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);
    const project = projectRows[0];
    if (!project) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }
    if (target && target.projectId !== projectId) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "The execution target belongs to a different project.",
      );
    }
    if (target?.kind === "surface") {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "A new surface cannot use an existing surface as its placement target.",
      );
    }

    const [settingsRows, workers, replicaRows] = await Promise.all([
      this.database
        .select({ defaultWorkerId: schema.userSettings.defaultWorkerId })
        .from(schema.userSettings)
        .where(eq(schema.userSettings.userId, ownerId))
        .limit(1),
      this.database
        .select()
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .orderBy(asc(schema.workers.id)),
      this.database
        .select({
          source: schema.projectSources,
          worktree: schema.projectWorktrees,
        })
        .from(schema.projectSources)
        .leftJoin(
          schema.projectWorktrees,
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
        )
        .where(
          and(
            eq(schema.projectSources.projectId, projectId),
            isNull(schema.projectSources.removedAt),
          ),
        ),
    ]);
    const workerById = new Map(workers.map((worker) => [worker.id, worker]));
    const folderProject = project.originKind === "managed-folder";
    const owningWorkerId = folderProject
      ? (project.preferredWorkerId ??
        replicaRows.find(({ source }) => source.sourceKind === "folder")?.source
          .workerId ??
        null)
      : null;
    const requiresExecutionRoot =
      folderProject ||
      surfaceKind === "chat" ||
      surfaceKind === "terminal" ||
      surfaceKind === "explorer" ||
      surfaceKind === "code";
    const workerSupportsSurface = (worker: WorkerRow): boolean => {
      if (surfaceKind === "code") return worker.codeCapabilities.available;
      if (surfaceKind === "browser") {
        return worker.remoteSurfaceCapabilities.browser;
      }
      if (surfaceKind === "remote-desktop") {
        return worker.remoteSurfaceCapabilities.desktop;
      }
      return true;
    };
    const sourceForWorker = (workerId: string) =>
      replicaRows.find(({ source }) => source.workerId === workerId)?.source ??
      null;
    const readyWorktreesForSource = (sourceId: string) =>
      replicaRows
        .flatMap(({ source, worktree }) =>
          source.id === sourceId &&
          worktree &&
          worktree.workerId === source.workerId &&
          worktree.lifecycleState === "ready"
            ? [worktree]
            : [],
        )
        .sort(
          (left, right) =>
            Number(right.isDefault) - Number(left.isDefault) ||
            Number(right.isPrimary) - Number(left.isPrimary) ||
            left.createdAt.getTime() - right.createdAt.getTime() ||
            left.id.localeCompare(right.id),
        );

    const placementForWorker = (
      workerId: string,
      selection: ExecutionPlacementResolution["selection"],
      explicitSourceId?: string,
      explicitWorktreeId?: string,
      strict = false,
    ): ExecutionPlacementResolution | null => {
      if (owningWorkerId !== null && workerId !== owningWorkerId) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "This worker-managed folder is bound to its owning worker.",
        );
      }
      const worker = workerById.get(workerId);
      if (!worker) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worker is not linked to this account.",
        );
      }
      const offlineAllowed = strict && allowOfflineExplicit;
      const workerIsOnline = workerIsOnlineForPlacement(
        worker,
        isWorkerConnected,
      );
      if (!offlineAllowed && !workerIsOnline) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "worker-offline",
          `Worker ${worker.displayName ?? worker.name} is offline.`,
        );
      }
      if (!workerSupportsSurface(worker)) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "capability-unavailable",
          `Worker ${worker.displayName ?? worker.name} does not support ${surfaceKind}.`,
        );
      }
      const source = explicitSourceId
        ? (replicaRows.find(({ source }) => source.id === explicitSourceId)
            ?.source ?? null)
        : sourceForWorker(workerId);
      if (explicitSourceId && (!source || source.workerId !== workerId)) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected replica is not active on this worker.",
        );
      }
      if (!requiresExecutionRoot) {
        return {
          placement: {
            projectId,
            workerId,
            projectReplicaId: explicitSourceId ?? null,
            worktreeId: explicitWorktreeId ?? null,
            surface: null,
          },
          selection,
        };
      }
      if (!source) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "replica-unavailable",
          folderProject
            ? "The worker-managed folder has not finished preparing its execution root."
            : "The selected worker does not have an active project replica.",
        );
      }
      const worktrees = readyWorktreesForSource(source.id);
      const worktree = explicitWorktreeId
        ? worktrees.find(({ id }) => id === explicitWorktreeId)
        : worktrees[0];
      if (!worktree) {
        if (!strict) return null;
        throw new ExecutionPlacementUnavailableError(
          "worktree-unavailable",
          folderProject
            ? "The worker-managed folder execution root is not ready."
            : explicitWorktreeId
              ? "The selected worktree is not ready on this project replica."
              : "The selected project replica has no ready worktree.",
        );
      }
      return {
        placement: {
          projectId,
          workerId,
          projectReplicaId: source.id,
          worktreeId: worktree.id,
          surface: null,
        },
        selection,
      };
    };

    if (target && target.kind !== "project") {
      if (target.kind === "worker") {
        return placementForWorker(
          target.workerId,
          "explicit",
          undefined,
          undefined,
          true,
        )!;
      }
      if (target.kind === "replica") {
        const source = replicaRows.find(
          ({ source }) => source.id === target.projectReplicaId,
        )?.source;
        if (!source) {
          throw new ExecutionPlacementUnavailableError(
            "target-not-found",
            "The selected project replica was not found.",
          );
        }
        return placementForWorker(
          source.workerId,
          "explicit",
          source.id,
          undefined,
          true,
        )!;
      }
      const row = replicaRows.find(
        ({ worktree }) => worktree?.id === target.worktreeId,
      );
      if (!row?.worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worktree was not found.",
        );
      }
      if (row.worktree.workerId !== row.source.workerId) {
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "The selected worktree and project replica belong to different workers.",
        );
      }
      if (row.worktree.lifecycleState !== "ready") {
        throw new ExecutionPlacementUnavailableError(
          "worktree-unavailable",
          "The selected worktree is not ready.",
        );
      }
      return placementForWorker(
        row.worktree.workerId,
        "explicit",
        row.source.id,
        row.worktree.id,
        true,
      )!;
    }

    const preferredCandidates: Array<{
      selection: ExecutionPlacementResolution["selection"];
      workerId: string | null;
    }> = folderProject
      ? [
          {
            workerId: owningWorkerId,
            selection: "project-preference",
          },
        ]
      : [
          {
            workerId: project.preferredWorkerId,
            selection: "project-preference",
          },
          {
            workerId: settingsRows[0]?.defaultWorkerId ?? null,
            selection: "default-worker",
          },
        ];
    const visited = new Set<string>();
    for (const candidate of preferredCandidates) {
      if (!candidate.workerId || visited.has(candidate.workerId)) continue;
      visited.add(candidate.workerId);
      const placement = placementForWorker(
        candidate.workerId,
        candidate.selection,
        undefined,
        undefined,
        folderProject,
      );
      if (placement) return placement;
    }
    for (const worker of folderProject ? [] : workers) {
      if (visited.has(worker.id)) continue;
      const placement = placementForWorker(worker.id, "fallback");
      if (placement) return placement;
    }
    throw new ExecutionPlacementUnavailableError(
      "no-compatible-placement",
      `No online worker has a compatible ${surfaceKind} placement for this project.`,
    );
  }
}

export function workerIsOnlineForPlacement(
  worker: Pick<WorkerRow, "id" | "lastSeenAt">,
  isWorkerConnected?: (workerId: string) => boolean,
): boolean {
  return isWorkerConnected
    ? isWorkerConnected(worker.id)
    : Date.now() - worker.lastSeenAt.getTime() <= WORKER_ONLINE_WINDOW_MS;
}
