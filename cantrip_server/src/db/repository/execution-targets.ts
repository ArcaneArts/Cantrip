import type {
  BrowserWireSummary,
  ExecutionPlacement,
  ExecutionTarget,
  ExecutionTargetResolution,
  ExecutionTargetResourceKind,
  ExecutionTargetWireCatalog,
  ExplorerWireSummary,
  ProjectReplicaSummary,
  ProjectWorktreeSummary,
  TerminalWireSummary,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { unionAll } from "drizzle-orm/pg-core";

import {
  buildExecutionTargetCatalog,
  executionTargetAvailability,
  executionTargetId,
  selectExactExecutionTarget,
  selectExplicitExecutionTarget,
  selectExecutionTarget,
  type ExecutionTargetCapability,
  type ExecutionTargetSelectorCandidate,
  type ExecutionTargetSelectorResult,
  type FocusedExecutionTargetResourceKind,
} from "../../execution-targets/catalog.js";
import type { ServerRepository } from "../repository.js";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { ExecutionPlacementUnavailableError } from "./placement.js";

export type {
  ExecutionTargetSelectorResult,
  FocusedExecutionTargetResourceKind,
} from "../../execution-targets/catalog.js";

type PublicCollaboratorName =
  | "getChatExecutionContext"
  | "getCodeTabExecutionContext"
  | "getExplorerExecutionContext"
  | "getProject"
  | "getProjectWorktreeContext"
  | "getRemoteDesktop"
  | "getRemoteSurfaceExecutionContext"
  | "getTerminalExecutionContext"
  | "getWorker"
  | "listBrowsers"
  | "listChats"
  | "listCodeTabs"
  | "listExplorers"
  | "listProjectExecutionTargets"
  | "listProjectReplicas"
  | "listProjectWorktrees"
  | "listRemoteDesktops"
  | "listRemoteSurfaces"
  | "listTerminals"
  | "listWorkers"
  | "resolveProjectExecutionPlacement";

export type ExecutionTargetRepositoryCollaborators = Pick<
  ServerRepository,
  PublicCollaboratorName
>;

export class ExecutionTargetRepository {
  constructor(
    private readonly database: RepositoryDatabase,
    private readonly collaborators: ExecutionTargetRepositoryCollaborators,
    private readonly browserIsOwnedBy: (
      ownerId: string,
      browserId: string,
    ) => Promise<boolean>,
  ) {}

  async resolveExecutionTarget(
    ownerId: string,
    projectId: string,
    target: ExecutionTarget,
    isWorkerConnected?: (workerId: string) => boolean,
    allowUnavailable = false,
  ): Promise<ExecutionTargetResolution> {
    if (target.projectId !== projectId) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "The execution target belongs to a different project.",
      );
    }
    const replicas = await this.collaborators.listProjectReplicas(
      ownerId,
      projectId,
    );
    if (!replicas) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }
    const project = await this.collaborators.getProject(ownerId, projectId);
    if (!project) {
      throw new ExecutionPlacementUnavailableError(
        "project-not-found",
        "Project not found.",
      );
    }

    let placement: ExecutionPlacement;
    let capability: ExecutionTargetCapability = null;
    let resourceUnavailableCode:
      "replica-unavailable" | "worktree-unavailable" | null = null;
    let resourceUnavailableReason: string | null = null;
    const placementForWorktree = async (
      worktreeId: string,
      workerId: string,
      surface: ExecutionPlacement["surface"],
    ): Promise<ExecutionPlacement> => {
      const worktree = (
        await this.collaborators.listProjectWorktrees(ownerId, projectId)
      ).find(({ id }) => id === worktreeId);
      if (!worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The target worktree was not found in this project.",
        );
      }
      if (worktree.workerId !== workerId) {
        throw new ExecutionPlacementUnavailableError(
          "target-mismatch",
          "The target resource and worktree belong to different workers.",
        );
      }
      if (worktree.lifecycleState !== "ready") {
        resourceUnavailableCode = "worktree-unavailable";
        resourceUnavailableReason = `Worktree ${worktree.name} is ${worktree.lifecycleState}.`;
      }
      return {
        projectId,
        workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId,
        surface,
      };
    };

    if (target.kind === "project") {
      placement = (
        await this.collaborators.resolveProjectExecutionPlacement(
          ownerId,
          projectId,
          "terminal",
          target,
          isWorkerConnected,
          allowUnavailable,
        )
      ).placement;
    } else if (target.kind === "worker") {
      const worker = await this.collaborators.getWorker(
        ownerId,
        target.workerId,
      );
      if (!worker) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worker is not linked to this account.",
        );
      }
      const replica = replicas.find(
        ({ workerId }) => workerId === target.workerId,
      );
      const primary = replica?.primaryWorktreeId
        ? await this.collaborators.getProjectWorktreeContext(
            ownerId,
            projectId,
            replica.primaryWorktreeId,
          )
        : null;
      placement = {
        projectId,
        workerId: target.workerId,
        projectReplicaId: replica?.id ?? null,
        worktreeId: primary?.worktree.id ?? null,
        surface: null,
      };
    } else if (target.kind === "replica") {
      const replica = replicas.find(({ id }) => id === target.projectReplicaId);
      if (!replica) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected project replica was not found.",
        );
      }
      const primary = replica.primaryWorktreeId
        ? await this.collaborators.getProjectWorktreeContext(
            ownerId,
            projectId,
            replica.primaryWorktreeId,
          )
        : null;
      if (!replica.ready || !primary) {
        resourceUnavailableCode = "replica-unavailable";
        resourceUnavailableReason = `The project replica on ${replica.workerName} is not ready.`;
      }
      placement = {
        projectId,
        workerId: replica.workerId,
        projectReplicaId: replica.id,
        worktreeId: primary?.worktree.id ?? null,
        surface: null,
      };
    } else if (target.kind === "worktree") {
      const worktree = (
        await this.collaborators.listProjectWorktrees(ownerId, projectId)
      ).find(({ id }) => id === target.worktreeId);
      if (!worktree) {
        throw new ExecutionPlacementUnavailableError(
          "target-not-found",
          "The selected worktree was not found.",
        );
      }
      if (worktree.lifecycleState !== "ready") {
        resourceUnavailableCode = "worktree-unavailable";
        resourceUnavailableReason = `Worktree ${worktree.name} is ${worktree.lifecycleState}.`;
      }
      placement = {
        projectId,
        workerId: worktree.workerId,
        projectReplicaId: worktree.projectSourceId,
        worktreeId: worktree.id,
        surface: null,
      };
    } else {
      const surface = {
        kind: target.surfaceKind,
        id: target.surfaceId,
      } as const;
      switch (target.surfaceKind) {
        case "chat": {
          const context = await this.collaborators.getChatExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected chat was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "terminal": {
          const context = await this.collaborators.getTerminalExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected terminal was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "explorer": {
          const context = await this.collaborators.getExplorerExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected Explorer was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          break;
        }
        case "code": {
          const context = await this.collaborators.getCodeTabExecutionContext(
            ownerId,
            target.surfaceId,
          );
          if (!context || context.codeTab.projectId !== projectId) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              "The selected Code tab was not found.",
            );
          }
          placement = await placementForWorktree(
            context.worktreeId,
            context.workerId,
            surface,
          );
          capability = "code";
          break;
        }
        case "browser":
        case "remote-desktop":
        case "remote-surface": {
          const [context, concreteSurfaceExists] = await Promise.all([
            this.collaborators.getRemoteSurfaceExecutionContext(
              ownerId,
              target.surfaceId,
            ),
            target.surfaceKind === "browser"
              ? this.browserIsOwnedBy(ownerId, target.surfaceId)
              : target.surfaceKind === "remote-desktop"
                ? this.collaborators
                    .getRemoteDesktop(ownerId, target.surfaceId)
                    .then((desktop) => desktop?.projectId === projectId)
                : Promise.resolve(true),
          ]);
          const expectedKind =
            target.surfaceKind === "browser"
              ? "browser"
              : target.surfaceKind === "remote-desktop"
                ? "desktop"
                : null;
          if (
            !context ||
            !concreteSurfaceExists ||
            context.surface.projectId !== projectId ||
            (expectedKind !== null && context.surface.kind !== expectedKind)
          ) {
            throw new ExecutionPlacementUnavailableError(
              "target-not-found",
              `The selected ${target.surfaceKind} was not found.`,
            );
          }
          placement = {
            projectId,
            workerId: context.workerId,
            projectReplicaId: null,
            worktreeId: null,
            surface,
          };
          capability =
            context.surface.kind === "browser" ? "browser" : "desktop";
          break;
        }
      }
    }

    if (
      project.originKind === "managed-folder" &&
      placement.workerId !==
        (project.preferredWorkerId ?? project.source?.workerId)
    ) {
      throw new ExecutionPlacementUnavailableError(
        "target-mismatch",
        "This worker-managed folder is bound to its owning worker.",
      );
    }

    const worker = await this.collaborators.getWorker(
      ownerId,
      placement.workerId,
    );
    if (!worker) {
      throw new ExecutionPlacementUnavailableError(
        "target-not-found",
        "The target worker is not linked to this account.",
      );
    }
    if (!allowUnavailable && resourceUnavailableCode) {
      throw new ExecutionPlacementUnavailableError(
        resourceUnavailableCode,
        resourceUnavailableReason!,
      );
    }
    let availability = executionTargetAvailability(
      worker,
      capability,
      isWorkerConnected,
    );
    if (!allowUnavailable && availability.availability !== "available") {
      throw new ExecutionPlacementUnavailableError(
        availability.availability === "worker-offline"
          ? "worker-offline"
          : "capability-unavailable",
        availability.unavailableReason!,
      );
    }
    if (
      availability.availability === "available" &&
      resourceUnavailableReason
    ) {
      availability = {
        availability: "resource-unavailable",
        online: true,
        unavailableReason: resourceUnavailableReason,
      };
    }
    return {
      target,
      placement,
      worker: {
        workerId: worker.workerId,
        name: worker.name,
        online: availability.online,
      },
      availability: availability.availability,
      unavailableReason: availability.unavailableReason,
    };
  }

  private async executionTargetProjectScope(
    ownerId: string,
    projectId: string,
  ): Promise<{
    folderProject: boolean;
    owningWorkerId: string | null;
  } | null> {
    const rows = await this.database
      .select({
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
        sourceWorkerId: schema.projectSources.workerId,
      })
      .from(schema.projects)
      .leftJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.projectId, schema.projects.id),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .leftJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.projectSourceId, schema.projectSources.id),
          eq(schema.projectWorktrees.isPrimary, true),
        ),
      )
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .orderBy(
        desc(
          sql<boolean>`coalesce(${schema.projectWorktrees.lifecycleState} = 'ready', false)`,
        ),
        asc(schema.projectSources.createdAt),
        asc(schema.projectSources.id),
      )
      .limit(1);
    const row = rows[0];
    return row
      ? {
          folderProject: row.originKind === "managed-folder",
          owningWorkerId: row.preferredWorkerId ?? row.sourceWorkerId,
        }
      : null;
  }

  private buildFocusedExecutionTargetCatalog(
    projectId: string,
    resourceKind: FocusedExecutionTargetResourceKind,
    scope: { folderProject: boolean; owningWorkerId: string | null },
    resources: {
      browsers?: readonly BrowserWireSummary[];
      explorers?: readonly ExplorerWireSummary[];
      replicas?: readonly ProjectReplicaSummary[];
      terminals?: readonly TerminalWireSummary[];
      workers: readonly WorkerSummary[];
      worktrees?: readonly ProjectWorktreeSummary[];
    },
    isWorkerConnected?: (workerId: string) => boolean,
  ): ExecutionTargetWireCatalog {
    const catalog = buildExecutionTargetCatalog({
      browsers: resources.browsers ?? [],
      chats: [],
      codeTabs: [],
      desktops: [],
      explorers: resources.explorers ?? [],
      isWorkerConnected,
      maximumTargets: null,
      projectId,
      remoteSurfaces: [],
      replicas: resources.replicas ?? [],
      resourceKinds: [resourceKind],
      terminals: resources.terminals ?? [],
      workers: scope.folderProject
        ? resources.workers.filter(
            ({ workerId }) => workerId === scope.owningWorkerId,
          )
        : resources.workers,
      worktrees: resources.worktrees ?? [],
    });
    return scope.folderProject && resourceKind === "worktree"
      ? { ...catalog, targets: [] }
      : catalog;
  }

  private async listFocusedProjectExecutionTargets(
    ownerId: string,
    projectId: string,
    resourceKind: FocusedExecutionTargetResourceKind,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetWireCatalog | null> {
    const scopePromise = this.executionTargetProjectScope(ownerId, projectId);
    switch (resourceKind) {
      case "browser": {
        const [scope, browsers, workers] = await Promise.all([
          scopePromise,
          this.collaborators.listBrowsers(ownerId, projectId),
          this.collaborators.listWorkers(ownerId),
        ]);
        return scope
          ? this.buildFocusedExecutionTargetCatalog(
              projectId,
              resourceKind,
              scope,
              { browsers, workers },
              isWorkerConnected,
            )
          : null;
      }
      case "explorer": {
        const [scope, explorers, workers, worktrees] = await Promise.all([
          scopePromise,
          this.collaborators.listExplorers(ownerId, projectId),
          this.collaborators.listWorkers(ownerId),
          this.collaborators.listProjectWorktrees(ownerId, projectId),
        ]);
        return scope
          ? this.buildFocusedExecutionTargetCatalog(
              projectId,
              resourceKind,
              scope,
              { explorers, workers, worktrees },
              isWorkerConnected,
            )
          : null;
      }
      case "terminal": {
        const [scope, terminals, workers, worktrees] = await Promise.all([
          scopePromise,
          this.collaborators.listTerminals(ownerId, projectId),
          this.collaborators.listWorkers(ownerId),
          this.collaborators.listProjectWorktrees(ownerId, projectId),
        ]);
        return scope
          ? this.buildFocusedExecutionTargetCatalog(
              projectId,
              resourceKind,
              scope,
              { terminals, workers, worktrees },
              isWorkerConnected,
            )
          : null;
      }
      case "worker": {
        const [scope, replicas, workers, worktrees] = await Promise.all([
          scopePromise,
          this.collaborators.listProjectReplicas(ownerId, projectId),
          this.collaborators.listWorkers(ownerId),
          this.collaborators.listProjectWorktrees(ownerId, projectId),
        ]);
        return scope && replicas
          ? this.buildFocusedExecutionTargetCatalog(
              projectId,
              resourceKind,
              scope,
              { replicas, workers, worktrees },
              isWorkerConnected,
            )
          : null;
      }
      case "worktree": {
        const [scope, workers, worktrees] = await Promise.all([
          scopePromise,
          this.collaborators.listWorkers(ownerId),
          this.collaborators.listProjectWorktrees(ownerId, projectId),
        ]);
        return scope
          ? this.buildFocusedExecutionTargetCatalog(
              projectId,
              resourceKind,
              scope,
              { workers, worktrees },
              isWorkerConnected,
            )
          : null;
      }
    }
  }

  private async listUntypedExecutionTargetSelectorCandidates(
    ownerId: string,
    projectId: string,
    scope: { folderProject: boolean; owningWorkerId: string | null },
    selector: string,
    exactOnly: boolean,
  ): Promise<ExecutionTargetSelectorCandidate[]> {
    const workerAllowed = (workerId: typeof schema.workers.id) =>
      scope.folderProject
        ? eq(workerId, scope.owningWorkerId ?? "")
        : undefined;
    const folderRootExcluded = scope.folderProject
      ? sql<boolean>`false`
      : undefined;
    const noTitle = sql<string | null>`null::text`;
    const idMatches = (column: AnyPgColumn) =>
      exactOnly
        ? sql<boolean>`${column} = ${selector}`
        : sql<boolean>`starts_with(${column}, ${selector})`;
    const selectorTitle = selector.toLocaleLowerCase();
    const selectorNeedsJsTitleFallback = /[^\x00-\x7f]/u.test(selector);
    const plaintextCandidateMatches = (
      id: AnyPgColumn,
      title: SQL<string | null>,
    ) =>
      or(
        idMatches(id),
        selectorNeedsJsTitleFallback
          ? sql<boolean>`true`
          : or(
              sql<boolean>`length(${title}) <> octet_length(${title})`,
              exactOnly
                ? sql<boolean>`lower(${title}) = ${selectorTitle}`
                : sql<boolean>`strpos(lower(${title}), ${selectorTitle}) > 0`,
            ),
      );

    const workerTitle = sql<
      string | null
    >`coalesce(${schema.workers.displayName}, ${schema.workers.name})`;
    const workers = this.database
      .select({
        id: schema.workers.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'worker'::text`,
        surfaceKind: sql<string | null>`null::text`,
        title: workerTitle,
      })
      .from(schema.workers)
      .where(
        and(
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
          workerAllowed(schema.workers.id),
          plaintextCandidateMatches(schema.workers.id, workerTitle),
        ),
      );
    const replicaTitle = sql<
      string | null
    >`${workerTitle} || ' project replica'`;
    const replicas = this.database
      .select({
        id: schema.projectSources.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'replica'::text`,
        surfaceKind: sql<string | null>`null::text`,
        title: replicaTitle,
      })
      .from(schema.projectSources)
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.projectSources.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
          folderRootExcluded,
          plaintextCandidateMatches(schema.projectSources.id, replicaTitle),
        ),
      );
    const worktreeTitle = sql<string | null>`${schema.projectWorktrees.name}`;
    const worktrees = this.database
      .select({
        id: schema.projectWorktrees.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'worktree'::text`,
        surfaceKind: sql<string | null>`null::text`,
        title: worktreeTitle,
      })
      .from(schema.projectWorktrees)
      .innerJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.projectWorktrees.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          folderRootExcluded,
          plaintextCandidateMatches(schema.projectWorktrees.id, worktreeTitle),
        ),
      );
    const chats = this.database
      .select({
        id: schema.chats.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'chat'::text`,
        surfaceKind: sql<string | null>`'chat'::text`,
        title: noTitle,
      })
      .from(schema.chats)
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.chats.activeWorktreeId),
          or(
            isNull(schema.chats.activeWorkerId),
            eq(schema.projectWorktrees.workerId, schema.chats.activeWorkerId),
          ),
        ),
      )
      .innerJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.projectWorktrees.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.chats.projectId, projectId),
          isNull(schema.chats.archivedAt),
          workerAllowed(schema.workers.id),
          idMatches(schema.chats.id),
        ),
      );
    const terminals = this.database
      .select({
        id: schema.terminals.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'terminal'::text`,
        surfaceKind: sql<string | null>`'terminal'::text`,
        title: noTitle,
      })
      .from(schema.terminals)
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
          eq(schema.projectWorktrees.workerId, schema.terminals.activeWorkerId),
        ),
      )
      .innerJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.terminals.activeWorkerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.terminals.projectId, projectId),
          ne(schema.terminals.kind, "run-configuration"),
          workerAllowed(schema.workers.id),
          idMatches(schema.terminals.id),
        ),
      );
    const explorers = this.database
      .select({
        id: schema.explorers.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'explorer'::text`,
        surfaceKind: sql<string | null>`'explorer'::text`,
        title: noTitle,
      })
      .from(schema.explorers)
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.explorers.worktreeId),
          eq(schema.projectWorktrees.workerId, schema.explorers.activeWorkerId),
        ),
      )
      .innerJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.explorers.activeWorkerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.explorers.projectId, projectId),
          workerAllowed(schema.workers.id),
          idMatches(schema.explorers.id),
        ),
      );
    const codeTabs = this.database
      .select({
        id: schema.codeTabs.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'code'::text`,
        surfaceKind: sql<string | null>`'code'::text`,
        title: noTitle,
      })
      .from(schema.codeTabs)
      .innerJoin(
        schema.projectWorktrees,
        and(
          eq(schema.projectWorktrees.id, schema.codeTabs.worktreeId),
          eq(schema.projectWorktrees.workerId, schema.codeTabs.activeWorkerId),
        ),
      )
      .innerJoin(
        schema.projectSources,
        and(
          eq(schema.projectSources.id, schema.projectWorktrees.projectSourceId),
          eq(schema.projectSources.projectId, projectId),
          isNull(schema.projectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.codeTabs.activeWorkerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.codeTabs.projectId, projectId),
          workerAllowed(schema.workers.id),
          idMatches(schema.codeTabs.id),
        ),
      );
    const browsers = this.database
      .select({
        id: schema.browsers.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'browser'::text`,
        surfaceKind: sql<string | null>`'browser'::text`,
        title: noTitle,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.remoteSurfaces,
        and(
          eq(schema.remoteSurfaces.id, schema.browsers.id),
          eq(schema.remoteSurfaces.projectId, projectId),
          eq(schema.remoteSurfaces.kind, "browser"),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.browsers.projectId, projectId),
          workerAllowed(schema.workers.id),
          idMatches(schema.browsers.id),
        ),
      );
    const desktops = this.database
      .select({
        id: schema.projectViews.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'remote-desktop'::text`,
        surfaceKind: sql<string | null>`'remote-desktop'::text`,
        title: noTitle,
      })
      .from(schema.projectViews)
      .innerJoin(
        schema.remoteSurfaces,
        and(
          eq(schema.remoteSurfaces.id, schema.projectViews.id),
          eq(schema.remoteSurfaces.projectId, projectId),
          eq(schema.remoteSurfaces.kind, "desktop"),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.projectViews.projectId, projectId),
          eq(schema.projectViews.kind, "remote-desktop"),
          workerAllowed(schema.workers.id),
          idMatches(schema.projectViews.id),
        ),
      );
    const remoteSurfaces = this.database
      .select({
        id: schema.remoteSurfaces.id,
        resourceKind: sql<ExecutionTargetResourceKind>`'remote-surface'::text`,
        surfaceKind: sql<string | null>`'remote-surface'::text`,
        title: noTitle,
      })
      .from(schema.remoteSurfaces)
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.remoteSurfaces.projectId, projectId),
          workerAllowed(schema.workers.id),
          idMatches(schema.remoteSurfaces.id),
          sql<boolean>`not exists (
            select 1 from ${schema.browsers}
            where ${schema.browsers.id} = ${schema.remoteSurfaces.id}
          )`,
          sql<boolean>`not exists (
            select 1 from ${schema.projectViews}
            where ${schema.projectViews.id} = ${schema.remoteSurfaces.id}
              and ${schema.projectViews.kind} = 'remote-desktop'
              and ${schema.remoteSurfaces.kind} = 'desktop'
          )`,
        ),
      );

    const rows = await unionAll(
      workers,
      replicas,
      worktrees,
      chats,
      terminals,
      explorers,
      codeTabs,
      browsers,
      desktops,
      remoteSurfaces,
    );
    const candidates: ExecutionTargetSelectorCandidate[] = rows.map((row) => ({
      resourceKind: row.resourceKind,
      target:
        row.resourceKind === "worker"
          ? { kind: "worker", projectId, workerId: row.id }
          : row.resourceKind === "replica"
            ? { kind: "replica", projectId, projectReplicaId: row.id }
            : row.resourceKind === "worktree"
              ? { kind: "worktree", projectId, worktreeId: row.id }
              : {
                  kind: "surface",
                  projectId,
                  surfaceKind: row.surfaceKind as Extract<
                    ExecutionTarget,
                    { kind: "surface" }
                  >["surfaceKind"],
                  surfaceId: row.id,
                },
      title: row.title,
    }));
    candidates.sort(
      (left, right) =>
        left.resourceKind.localeCompare(right.resourceKind) ||
        executionTargetId(left.target).localeCompare(
          executionTargetId(right.target),
        ),
    );
    return candidates;
  }

  private async resolveExactFocusedExecutionTarget(
    ownerId: string,
    projectId: string,
    resourceKind: Extract<
      FocusedExecutionTargetResourceKind,
      "browser" | "explorer" | "terminal"
    >,
    resourceId: string,
  ): Promise<{
    folderProject: boolean;
    preferredWorkerId: string | null;
    target: ExecutionTarget;
    workerId: string;
  } | null> {
    if (resourceKind === "explorer") {
      const rows = await this.database
        .select({
          id: schema.explorers.id,
          originKind: schema.projects.originKind,
          preferredWorkerId: schema.projects.preferredWorkerId,
          workerId: schema.explorers.activeWorkerId,
        })
        .from(schema.explorers)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.explorers.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .innerJoin(
          schema.projectWorktrees,
          and(
            eq(schema.projectWorktrees.id, schema.explorers.worktreeId),
            eq(
              schema.projectWorktrees.workerId,
              schema.explorers.activeWorkerId,
            ),
          ),
        )
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            eq(schema.projectSources.projectId, schema.projects.id),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, schema.explorers.activeWorkerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .where(
          and(
            eq(schema.explorers.id, resourceId),
            eq(schema.explorers.projectId, projectId),
          ),
        )
        .limit(1);
      return rows[0]
        ? {
            folderProject: rows[0].originKind === "managed-folder",
            preferredWorkerId: rows[0].preferredWorkerId,
            target: {
              kind: "surface",
              projectId,
              surfaceKind: "explorer",
              surfaceId: resourceId,
            },
            workerId: rows[0].workerId,
          }
        : null;
    }
    if (resourceKind === "terminal") {
      const rows = await this.database
        .select({
          id: schema.terminals.id,
          originKind: schema.projects.originKind,
          preferredWorkerId: schema.projects.preferredWorkerId,
          workerId: schema.terminals.activeWorkerId,
        })
        .from(schema.terminals)
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, schema.terminals.projectId),
            eq(schema.projects.ownerId, ownerId),
          ),
        )
        .innerJoin(
          schema.projectWorktrees,
          and(
            eq(schema.projectWorktrees.id, schema.terminals.worktreeId),
            eq(
              schema.projectWorktrees.workerId,
              schema.terminals.activeWorkerId,
            ),
          ),
        )
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            eq(schema.projectSources.projectId, schema.projects.id),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .innerJoin(
          schema.workers,
          and(
            eq(schema.workers.id, schema.terminals.activeWorkerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .where(
          and(
            eq(schema.terminals.id, resourceId),
            eq(schema.terminals.projectId, projectId),
            ne(schema.terminals.kind, "run-configuration"),
          ),
        )
        .limit(1);
      return rows[0]
        ? {
            folderProject: rows[0].originKind === "managed-folder",
            preferredWorkerId: rows[0].preferredWorkerId,
            target: {
              kind: "surface",
              projectId,
              surfaceKind: "terminal",
              surfaceId: resourceId,
            },
            workerId: rows[0].workerId,
          }
        : null;
    }
    const rows = await this.database
      .select({
        id: schema.browsers.id,
        originKind: schema.projects.originKind,
        preferredWorkerId: schema.projects.preferredWorkerId,
        workerId: schema.remoteSurfaces.workerId,
      })
      .from(schema.browsers)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.browsers.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .innerJoin(
        schema.remoteSurfaces,
        and(
          eq(schema.remoteSurfaces.id, schema.browsers.id),
          eq(schema.remoteSurfaces.projectId, schema.projects.id),
          eq(schema.remoteSurfaces.kind, "browser"),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.remoteSurfaces.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.browsers.id, resourceId),
          eq(schema.browsers.projectId, projectId),
        ),
      )
      .limit(1);
    return rows[0]
      ? {
          folderProject: rows[0].originKind === "managed-folder",
          preferredWorkerId: rows[0].preferredWorkerId,
          target: {
            kind: "surface",
            projectId,
            surfaceKind: "browser",
            surfaceId: resourceId,
          },
          workerId: rows[0].workerId,
        }
      : null;
  }

  async resolveExecutionTargetSelector(
    ownerId: string,
    projectId: string,
    resourceKind: FocusedExecutionTargetResourceKind | null,
    selector: string | null,
    context: {
      terminalId: string | null;
      workerId: string;
      worktreeId: string;
    },
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetSelectorResult | null> {
    if (
      selector &&
      (resourceKind === "browser" ||
        resourceKind === "explorer" ||
        resourceKind === "terminal")
    ) {
      const exact = await this.resolveExactFocusedExecutionTarget(
        ownerId,
        projectId,
        resourceKind,
        selector,
      );
      if (exact) {
        const owningWorkerId = exact.folderProject
          ? (exact.preferredWorkerId ??
            (await this.executionTargetProjectScope(ownerId, projectId))
              ?.owningWorkerId ??
            null)
          : exact.workerId;
        if (exact.workerId === owningWorkerId) {
          return { outcome: "selected", target: exact.target };
        }
      }
    } else if (!selector && resourceKind === "terminal" && context.terminalId) {
      const current = await this.resolveExactFocusedExecutionTarget(
        ownerId,
        projectId,
        resourceKind,
        context.terminalId,
      );
      if (current) {
        const owningWorkerId = current.folderProject
          ? (current.preferredWorkerId ??
            (await this.executionTargetProjectScope(ownerId, projectId))
              ?.owningWorkerId ??
            null)
          : current.workerId;
        if (current.workerId === owningWorkerId) {
          return { outcome: "selected", target: current.target };
        }
      }
    } else if (!selector && resourceKind === "worker") {
      const [scope, worker] = await Promise.all([
        this.executionTargetProjectScope(ownerId, projectId),
        this.collaborators.getWorker(ownerId, context.workerId),
      ]);
      if (!scope) return null;
      if (scope.folderProject && scope.owningWorkerId === context.workerId) {
        if (
          worker &&
          executionTargetAvailability(worker, null, isWorkerConnected)
            .availability === "available"
        ) {
          return {
            outcome: "selected",
            target: {
              kind: "worker",
              projectId,
              workerId: context.workerId,
            },
          };
        }
        return { outcome: "unavailable" };
      }
    }

    if (!resourceKind && selector) {
      const scope = await this.executionTargetProjectScope(ownerId, projectId);
      if (!scope) return null;
      const exactCandidates =
        await this.listUntypedExecutionTargetSelectorCandidates(
          ownerId,
          projectId,
          scope,
          selector,
          true,
        );
      const exact = selectExactExecutionTarget(exactCandidates, selector);
      if (exact) return exact;
      const partialCandidates =
        await this.listUntypedExecutionTargetSelectorCandidates(
          ownerId,
          projectId,
          scope,
          selector,
          false,
        );
      return selectExplicitExecutionTarget(partialCandidates, selector);
    }

    const catalog = resourceKind
      ? await this.listFocusedProjectExecutionTargets(
          ownerId,
          projectId,
          resourceKind,
          isWorkerConnected,
        )
      : await this.collaborators.listProjectExecutionTargets(
          ownerId,
          projectId,
          isWorkerConnected,
        );
    return catalog
      ? selectExecutionTarget(catalog.targets, {
          currentTerminalId: context.terminalId,
          currentWorkerId: context.workerId,
          currentWorktreeId: context.worktreeId,
          resourceKind,
          selector,
        })
      : null;
  }

  async listProjectExecutionTargets(
    ownerId: string,
    projectId: string,
    isWorkerConnected?: (workerId: string) => boolean,
  ): Promise<ExecutionTargetWireCatalog | null> {
    const [
      project,
      replicas,
      workers,
      worktrees,
      chats,
      terminals,
      explorers,
      codeTabs,
      browsers,
      desktops,
      remoteSurfaces,
    ] = await Promise.all([
      this.collaborators.getProject(ownerId, projectId),
      this.collaborators.listProjectReplicas(ownerId, projectId),
      this.collaborators.listWorkers(ownerId),
      this.collaborators.listProjectWorktrees(ownerId, projectId),
      this.collaborators.listChats(ownerId, projectId),
      this.collaborators.listTerminals(ownerId, projectId),
      this.collaborators.listExplorers(ownerId, projectId),
      this.collaborators.listCodeTabs(ownerId, projectId),
      this.collaborators.listBrowsers(ownerId, projectId),
      this.collaborators.listRemoteDesktops(ownerId, projectId),
      this.collaborators.listRemoteSurfaces(ownerId, projectId),
    ]);
    if (!project || !replicas) return null;
    const folderProject = project.originKind === "managed-folder";
    const owningWorkerId =
      project.preferredWorkerId ?? project.source?.workerId ?? null;
    const catalog = buildExecutionTargetCatalog({
      browsers,
      chats,
      codeTabs,
      desktops,
      explorers,
      isWorkerConnected,
      projectId,
      remoteSurfaces,
      replicas,
      terminals,
      workers: folderProject
        ? workers.filter(({ workerId }) => workerId === owningWorkerId)
        : workers,
      worktrees,
    });
    return folderProject
      ? {
          ...catalog,
          targets: catalog.targets.filter(
            ({ resourceKind }) =>
              resourceKind !== "replica" && resourceKind !== "worktree",
          ),
        }
      : catalog;
  }
}
