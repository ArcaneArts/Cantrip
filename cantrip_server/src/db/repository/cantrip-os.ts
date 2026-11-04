import { randomUUID } from "node:crypto";
import {
  cantripOsAttachSchema,
  cantripOsDependencyOverlaysSchema,
  cantripOsInstanceSummarySchema,
  cantripOsProjectSourceSummarySchema,
  cantripOsSourceBindingSummarySchema,
  cantripOsTransportSchema,
  cantripOsWorkspaceSummarySchema,
  cantripOsWorkspaceObservationSchema,
  type CantripOsDependencyOverlay,
  type CantripOsTransport,
  type ProjectSourceKind,
} from "@cantrip/protocol";
import { and, asc, eq, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { requireWorkerLocalPath } from "./worker-local-source-path.js";

const instance = (row: typeof schema.cantripOsInstances.$inferSelect) =>
  cantripOsInstanceSummarySchema.parse({
    ...row,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    lastObservedAt: row.lastObservedAt?.toISOString() ?? null,
  });
const workspace = (
  row: typeof schema.cantripOsWorkspaces.$inferSelect,
  workerId: string,
) =>
  cantripOsWorkspaceSummarySchema.parse({
    ...row,
    workerId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });
const binding = (
  {
    retiredAt: _retired,
    ...row
  }: typeof schema.cantripOsSourceBindings.$inferSelect,
  instanceId: string,
) =>
  cantripOsSourceBindingSummarySchema.parse({
    ...row,
    instanceId,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  });

export class CantripOsPlacementError extends Error {}
const fail = (message: string): never => {
  throw new CantripOsPlacementError(message);
};

/** Server-owned identities and placement. This repository never touches a
 * filesystem or retries guest mutations. Observations must come from the owning
 * authenticated worker; clients cannot supply UID/path or success receipts. */
export class CantripOsRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async list(ownerId: string) {
    const rows = await this.database
      .select()
      .from(schema.cantripOsInstances)
      .where(eq(schema.cantripOsInstances.ownerId, ownerId))
      .orderBy(
        asc(schema.cantripOsInstances.createdAt),
        asc(schema.cantripOsInstances.id),
      );
    return rows.map(instance);
  }

  async attachment(ownerId: string, instanceId: string) {
    const [row] = await this.database
      .select()
      .from(schema.cantripOsInstances)
      .where(
        and(
          eq(schema.cantripOsInstances.id, instanceId),
          eq(schema.cantripOsInstances.ownerId, ownerId),
        ),
      );
    return row
      ? {
          instance: instance(row),
          transport: cantripOsTransportSchema.parse(row.transport),
        }
      : null;
  }

  async attach(
    ownerId: string,
    input: {
      workerId: string;
      guestInstanceId: string;
      name: string;
      transport: CantripOsTransport;
      expectedAttachmentGeneration: string | null;
    },
  ) {
    cantripOsAttachSchema.parse(input);
    const transport = cantripOsTransportSchema.parse(input.transport);
    return this.database.transaction(async (tx) => {
      const [worker] = await tx
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
            isNull(schema.workers.unlinkedAt),
          ),
        )
        .for("update");
      if (!worker) return fail("Owning worker is unavailable.");
      const [old] = await tx
        .select()
        .from(schema.cantripOsInstances)
        .where(
          and(
            eq(schema.cantripOsInstances.workerId, input.workerId),
            eq(
              schema.cantripOsInstances.guestInstanceId,
              input.guestInstanceId,
            ),
          ),
        );
      if (
        (old?.attachmentGeneration ?? null) !==
        input.expectedAttachmentGeneration
      )
        return fail("OS attachment changed; refresh before attaching again.");
      const values = {
        attachmentGeneration: randomUUID(),
        transport,
        name: input.name,
        status: "unknown" as const,
        runtimeGeneration: null,
        lastError: null,
        lastObservedAt: null,
        updatedAt: new Date(),
      };
      const [row] = old
        ? await tx
            .update(schema.cantripOsInstances)
            .set(values)
            .where(eq(schema.cantripOsInstances.id, old.id))
            .returning()
        : await tx
            .insert(schema.cantripOsInstances)
            .values({
              id: randomUUID(),
              ownerId,
              workerId: worker.id,
              guestInstanceId: input.guestInstanceId,
              ...values,
            })
            .returning();
      return instance(row!);
    });
  }

  async observe(
    ownerId: string,
    instanceId: string,
    expectedAttachmentGeneration: string,
    observation: {
      status: "connected" | "disconnected" | "unknown";
      runtimeGeneration: string | null;
      lastError: string | null;
    },
  ) {
    const [row] = await this.database
      .update(schema.cantripOsInstances)
      .set({
        ...observation,
        lastObservedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(schema.cantripOsInstances.id, instanceId),
          eq(schema.cantripOsInstances.ownerId, ownerId),
          eq(
            schema.cantripOsInstances.attachmentGeneration,
            expectedAttachmentGeneration,
          ),
        ),
      )
      .returning();
    return row
      ? instance(row)
      : fail("OS attachment changed before observation arrived.");
  }

  async recordWorkspace(
    ownerId: string,
    instanceId: string,
    attachmentGeneration: string,
    observation: {
      guestWorkspaceId: string;
      uid: number;
      gid: number;
      homeGuestPath: string;
    },
  ) {
    cantripOsWorkspaceObservationSchema.parse(observation);
    return this.database.transaction(async (tx) => {
      const [parent] = await tx
        .select()
        .from(schema.cantripOsInstances)
        .where(
          and(
            eq(schema.cantripOsInstances.id, instanceId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
            eq(
              schema.cantripOsInstances.attachmentGeneration,
              attachmentGeneration,
            ),
          ),
        )
        .for("update");
      if (!parent)
        return fail(
          "OS attachment changed before workspace observation arrived.",
        );
      const [old] = await tx
        .select()
        .from(schema.cantripOsWorkspaces)
        .where(
          and(
            eq(schema.cantripOsWorkspaces.instanceId, instanceId),
            eq(
              schema.cantripOsWorkspaces.guestWorkspaceId,
              observation.guestWorkspaceId,
            ),
          ),
        );
      if (old) {
        if (
          old.uid !== observation.uid ||
          old.gid !== observation.gid ||
          old.homeGuestPath !== observation.homeGuestPath
        )
          return fail(
            "OS workspace identity changed; the existing placement was preserved.",
          );
        return workspace(old, parent.workerId);
      }
      const [row] = await tx
        .insert(schema.cantripOsWorkspaces)
        .values({ id: randomUUID(), instanceId, ...observation })
        .returning();
      return workspace(row!, parent.workerId);
    });
  }

  async listWorkspaces(ownerId: string, instanceId: string) {
    const rows = await this.database
      .select({
        workspace: schema.cantripOsWorkspaces,
        workerId: schema.cantripOsInstances.workerId,
      })
      .from(schema.cantripOsWorkspaces)
      .innerJoin(
        schema.cantripOsInstances,
        eq(schema.cantripOsInstances.id, schema.cantripOsWorkspaces.instanceId),
      )
      .where(
        and(
          eq(schema.cantripOsInstances.id, instanceId),
          eq(schema.cantripOsInstances.ownerId, ownerId),
        ),
      )
      .orderBy(
        asc(schema.cantripOsWorkspaces.createdAt),
        asc(schema.cantripOsWorkspaces.id),
      );
    return rows.map((row) => workspace(row.workspace, row.workerId));
  }

  async createLinkedBinding(
    ownerId: string,
    input: {
      workspaceId: string;
      worktreeId: string;
      dependencyOverlays: CantripOsDependencyOverlay[];
    },
  ) {
    const overlays = cantripOsDependencyOverlaysSchema.parse(
      input.dependencyOverlays,
    );
    return this.database.transaction(async (tx) => {
      const [target] = await tx
        .select({
          source: schema.projectSources,
          worktree: schema.projectWorktrees,
          workspace: schema.cantripOsWorkspaces,
          instance: schema.cantripOsInstances,
        })
        .from(schema.projectWorktrees)
        .innerJoin(
          schema.projectSources,
          and(
            eq(
              schema.projectSources.id,
              schema.projectWorktrees.projectSourceId,
            ),
            isNull(schema.projectSources.removedAt),
          ),
        )
        .innerJoin(
          schema.projects,
          eq(schema.projects.id, schema.projectSources.projectId),
        )
        .innerJoin(
          schema.cantripOsWorkspaces,
          eq(schema.cantripOsWorkspaces.id, input.workspaceId),
        )
        .innerJoin(
          schema.cantripOsInstances,
          eq(
            schema.cantripOsInstances.id,
            schema.cantripOsWorkspaces.instanceId,
          ),
        )
        .where(
          and(
            eq(schema.projectWorktrees.id, input.worktreeId),
            eq(schema.projects.ownerId, ownerId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
            eq(
              schema.cantripOsInstances.workerId,
              schema.projectWorktrees.workerId,
            ),
            eq(schema.projectWorktrees.lifecycleState, "ready"),
          ),
        )
        .for("update");
      if (!target)
        return fail(
          "Linked worktree and OS workspace must belong to the same owner and worker.",
        );
      if (target.instance.transport.kind !== "docker")
        return fail("Linked checkouts require Docker on the owning worker.");
      const id = randomUUID();
      const [row] = await tx
        .insert(schema.cantripOsSourceBindings)
        .values({
          id,
          ownerId,
          projectId: target.source.projectId,
          workerId: target.source.workerId,
          projectSourceId: target.source.id,
          worktreeId: target.worktree.id,
          workspaceId: input.workspaceId,
          mode: "linked",
          linkedWorkerPath: requireWorkerLocalPath(
            target.worktree.absolutePath,
          ),
          guestPath: `/workspace/${id}`,
          bindingGeneration: randomUUID(),
          state: "provisioning",
          dependencyOverlays: overlays,
        })
        .returning();
      return binding(row!, target.instance.id);
    });
  }

  async createLinuxSource(
    ownerId: string,
    input: {
      projectId: string;
      workspaceId: string;
      sourceKind: ProjectSourceKind;
    },
  ) {
    return this.database.transaction(async (tx) => {
      const [target] = await tx
        .select({
          workspace: schema.cantripOsWorkspaces,
          instance: schema.cantripOsInstances,
        })
        .from(schema.cantripOsWorkspaces)
        .innerJoin(
          schema.cantripOsInstances,
          eq(
            schema.cantripOsInstances.id,
            schema.cantripOsWorkspaces.instanceId,
          ),
        )
        .innerJoin(
          schema.projects,
          and(
            eq(schema.projects.id, input.projectId),
            eq(schema.projects.ownerId, schema.cantripOsInstances.ownerId),
          ),
        )
        .where(
          and(
            eq(schema.cantripOsWorkspaces.id, input.workspaceId),
            eq(schema.cantripOsInstances.ownerId, ownerId),
          ),
        )
        .for("update");
      if (!target) return fail("Project and OS workspace must share an owner.");
      const sourceId = randomUUID(),
        worktreeId = randomUUID(),
        bindingId = randomUUID();
      const guestPath = `${target.workspace.homeGuestPath}/checkouts/${sourceId}`;
      await tx.insert(schema.projectSourceIdentities).values({
        id: sourceId,
        projectId: input.projectId,
        workerId: target.instance.workerId,
        locationKind: "cantrip-os",
      });
      const [source] = await tx
        .insert(schema.cantripOsProjectSources)
        .values({
          id: sourceId,
          workspaceId: input.workspaceId,
          sourceKind: input.sourceKind,
          guestPath,
          ownershipKind: "cantrip",
        })
        .returning();
      await tx.insert(schema.projectWorktrees).values({
        id: worktreeId,
        projectSourceId: sourceId,
        workerId: target.instance.workerId,
        locationKind: "cantrip-os",
        guestPath,
        displayPath: sourceId,
        rootKind: input.sourceKind === "git" ? "git-worktree" : "folder-root",
        name: "Primary",
        isPrimary: true,
        isDefault: true,
        origin: "cantrip",
        lifecycleState: "creating",
      });
      const [row] = await tx
        .insert(schema.cantripOsSourceBindings)
        .values({
          id: bindingId,
          ownerId,
          projectId: input.projectId,
          workerId: target.instance.workerId,
          projectSourceId: sourceId,
          worktreeId,
          workspaceId: input.workspaceId,
          mode: "linux-owned",
          guestPath,
          bindingGeneration: randomUUID(),
          state: "provisioning",
        })
        .returning();
      const { removedAt: _removed, ...sourceSummary } = source!;
      return {
        source: cantripOsProjectSourceSummarySchema.parse({
          ...sourceSummary,
          projectId: input.projectId,
          workerId: target.instance.workerId,
          instanceId: target.instance.id,
          primaryWorktreeId: worktreeId,
          createdAt: source!.createdAt.toISOString(),
          updatedAt: source!.updatedAt.toISOString(),
        }),
        binding: binding(row!, target.instance.id),
      };
    });
  }

  async listBindings(ownerId: string, projectId: string) {
    const rows = await this.database
      .select({
        binding: schema.cantripOsSourceBindings,
        instanceId: schema.cantripOsWorkspaces.instanceId,
      })
      .from(schema.cantripOsSourceBindings)
      .innerJoin(
        schema.cantripOsWorkspaces,
        eq(
          schema.cantripOsWorkspaces.id,
          schema.cantripOsSourceBindings.workspaceId,
        ),
      )
      .where(
        and(
          eq(schema.cantripOsSourceBindings.ownerId, ownerId),
          eq(schema.cantripOsSourceBindings.projectId, projectId),
          isNull(schema.cantripOsSourceBindings.retiredAt),
        ),
      )
      .orderBy(
        asc(schema.cantripOsSourceBindings.createdAt),
        asc(schema.cantripOsSourceBindings.id),
      );
    return rows.map((row) => binding(row.binding, row.instanceId));
  }

  async retireBinding(
    ownerId: string,
    id: string,
    expectedBindingGeneration: string,
  ) {
    const [row] = await this.database
      .update(schema.cantripOsSourceBindings)
      .set({ state: "retired", retiredAt: new Date(), updatedAt: new Date() })
      .where(
        and(
          eq(schema.cantripOsSourceBindings.ownerId, ownerId),
          eq(schema.cantripOsSourceBindings.id, id),
          eq(
            schema.cantripOsSourceBindings.bindingGeneration,
            expectedBindingGeneration,
          ),
          isNull(schema.cantripOsSourceBindings.retiredAt),
        ),
      )
      .returning({ id: schema.cantripOsSourceBindings.id });
    return row !== undefined;
  }

  /** Includes transport only on the server-to-worker authority path. An absent
   * guest never becomes a host cwd. A caller captures both generations. */
  async bindingContext(ownerId: string, id: string) {
    const [row] = await this.database
      .select({
        binding: schema.cantripOsSourceBindings,
        workspace: schema.cantripOsWorkspaces,
        instance: schema.cantripOsInstances,
        worktree: schema.projectWorktrees,
        localSource: schema.projectSources,
        linuxSource: schema.cantripOsProjectSources,
      })
      .from(schema.cantripOsSourceBindings)
      .innerJoin(
        schema.cantripOsWorkspaces,
        eq(
          schema.cantripOsWorkspaces.id,
          schema.cantripOsSourceBindings.workspaceId,
        ),
      )
      .innerJoin(
        schema.cantripOsInstances,
        eq(schema.cantripOsInstances.id, schema.cantripOsWorkspaces.instanceId),
      )
      .innerJoin(
        schema.projectWorktrees,
        eq(
          schema.projectWorktrees.id,
          schema.cantripOsSourceBindings.worktreeId,
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.cantripOsSourceBindings.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .leftJoin(
        schema.projectSources,
        eq(
          schema.projectSources.id,
          schema.cantripOsSourceBindings.projectSourceId,
        ),
      )
      .leftJoin(
        schema.cantripOsProjectSources,
        eq(
          schema.cantripOsProjectSources.id,
          schema.cantripOsSourceBindings.projectSourceId,
        ),
      )
      .where(
        and(
          eq(schema.cantripOsSourceBindings.id, id),
          eq(schema.cantripOsSourceBindings.ownerId, ownerId),
          isNull(schema.cantripOsSourceBindings.retiredAt),
        ),
      );
    return row
      ? {
          binding: binding(row.binding, row.instance.id),
          instance: instance(row.instance),
          workspace: workspace(row.workspace, row.instance.workerId),
          transport: cantripOsTransportSchema.parse(row.instance.transport),
          physicalLocation:
            row.binding.mode === "linked"
              ? {
                  kind: "worker-local" as const,
                  workerPath: requireWorkerLocalPath(
                    row.binding.linkedWorkerPath,
                  ),
                }
              : {
                  kind: "cantrip-os" as const,
                  instanceId: row.instance.id,
                  workspaceId: row.workspace.id,
                  guestPath: row.binding.guestPath,
                },
          worktreeState: row.worktree.lifecycleState,
          available:
            row.binding.state === "ready" &&
            row.worktree.projectSourceId === row.binding.projectSourceId &&
            row.worktree.workerId === row.binding.workerId &&
            row.worktree.lifecycleState === "ready" &&
            row.instance.status === "connected" &&
            row.binding.provisionedAttachmentGeneration ===
              row.instance.attachmentGeneration &&
            row.binding.provisionedRuntimeGeneration ===
              row.instance.runtimeGeneration &&
            (row.binding.mode === "linked"
              ? row.localSource !== null &&
                row.localSource.removedAt === null &&
                row.binding.linkedWorkerPath === row.worktree.absolutePath &&
                row.instance.transport.kind === "docker"
              : row.linuxSource !== null &&
                row.linuxSource.removedAt === null &&
                row.binding.guestPath === row.worktree.guestPath),
        }
      : null;
  }

  async executionContext(
    ownerId: string,
    id: string,
    expected: {
      bindingGeneration: string;
      attachmentGeneration: string;
      runtimeGeneration: string;
    },
  ) {
    const context = await this.bindingContext(ownerId, id);
    if (
      !context ||
      !context.available ||
      context.binding.bindingGeneration !== expected.bindingGeneration ||
      context.instance.attachmentGeneration !== expected.attachmentGeneration ||
      context.instance.runtimeGeneration !== expected.runtimeGeneration
    )
      return fail(
        "CantripOS execution placement is unavailable or changed; no host fallback was attempted.",
      );
    return context;
  }

  async recordBindingOutcome(
    ownerId: string,
    id: string,
    expected: {
      bindingGeneration: string;
      attachmentGeneration: string;
      runtimeGeneration: string;
    },
    outcome: {
      state: "ready" | "failed" | "unknown";
      lastError: string | null;
    },
  ) {
    return this.database.transaction(async (tx) => {
      const [current] = await tx
        .select({
          binding: schema.cantripOsSourceBindings,
          instance: schema.cantripOsInstances,
        })
        .from(schema.cantripOsSourceBindings)
        .innerJoin(
          schema.cantripOsWorkspaces,
          eq(
            schema.cantripOsWorkspaces.id,
            schema.cantripOsSourceBindings.workspaceId,
          ),
        )
        .innerJoin(
          schema.cantripOsInstances,
          eq(
            schema.cantripOsInstances.id,
            schema.cantripOsWorkspaces.instanceId,
          ),
        )
        .where(
          and(
            eq(schema.cantripOsSourceBindings.id, id),
            eq(schema.cantripOsSourceBindings.ownerId, ownerId),
            isNull(schema.cantripOsSourceBindings.retiredAt),
          ),
        )
        .for("update");
      if (
        !current ||
        current.binding.bindingGeneration !== expected.bindingGeneration ||
        current.instance.attachmentGeneration !==
          expected.attachmentGeneration ||
        current.instance.runtimeGeneration !== expected.runtimeGeneration
      )
        return fail(
          "OS placement changed before provisioning outcome arrived.",
        );
      const [row] = await tx
        .update(schema.cantripOsSourceBindings)
        .set({
          ...outcome,
          lastError: outcome.lastError?.slice(0, 4000) ?? null,
          provisionedAttachmentGeneration:
            outcome.state === "ready" ? expected.attachmentGeneration : null,
          provisionedRuntimeGeneration:
            outcome.state === "ready" ? expected.runtimeGeneration : null,
          updatedAt: new Date(),
        })
        .where(eq(schema.cantripOsSourceBindings.id, id))
        .returning();
      if (outcome.state === "ready" && current.binding.mode === "linux-owned")
        await tx
          .update(schema.projectWorktrees)
          .set({ lifecycleState: "ready", updatedAt: new Date() })
          .where(eq(schema.projectWorktrees.id, current.binding.worktreeId));
      return binding(row!, current.instance.id);
    });
  }
}
