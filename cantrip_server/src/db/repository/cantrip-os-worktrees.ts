import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";

export interface LinuxWorktreeAdmission {
  sourceBindingId: string;
  expectedRuntimeGeneration: string;
  operationId: string;
}

/** The client operation UUID admits one durable binding. Only provisioning
 * executes Git; repeated creation observes this same resource. */
export async function createLinuxWorktreeBinding(
  database: RepositoryDatabase,
  ownerId: string,
  projectId: string,
  input: LinuxWorktreeAdmission,
) {
  return database.transaction(async (tx) => {
    const [parent] = await tx
      .select({
        binding: schema.cantripOsSourceBindings,
        source: schema.cantripOsProjectSources,
        workspace: schema.cantripOsWorkspaces,
        instance: schema.cantripOsInstances,
      })
      .from(schema.cantripOsSourceBindings)
      .innerJoin(
        schema.cantripOsProjectSources,
        and(
          eq(
            schema.cantripOsProjectSources.id,
            schema.cantripOsSourceBindings.projectSourceId,
          ),
          eq(
            schema.cantripOsProjectSources.workspaceId,
            schema.cantripOsSourceBindings.workspaceId,
          ),
          eq(schema.cantripOsProjectSources.sourceKind, "git"),
          isNull(schema.cantripOsProjectSources.removedAt),
        ),
      )
      .innerJoin(
        schema.projectSourceIdentities,
        and(
          eq(
            schema.projectSourceIdentities.id,
            schema.cantripOsProjectSources.id,
          ),
          eq(schema.projectSourceIdentities.projectId, projectId),
          eq(
            schema.projectSourceIdentities.workerId,
            schema.cantripOsSourceBindings.workerId,
          ),
          eq(schema.projectSourceIdentities.locationKind, "cantrip-os"),
        ),
      )
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
          eq(schema.projects.gitCapability, true),
        ),
      )
      .innerJoin(
        schema.cantripOsWorkspaces,
        eq(
          schema.cantripOsWorkspaces.id,
          schema.cantripOsSourceBindings.workspaceId,
        ),
      )
      .innerJoin(
        schema.cantripOsInstances,
        and(
          eq(
            schema.cantripOsInstances.id,
            schema.cantripOsWorkspaces.instanceId,
          ),
          eq(schema.cantripOsInstances.ownerId, ownerId),
          eq(
            schema.cantripOsInstances.workerId,
            schema.cantripOsSourceBindings.workerId,
          ),
        ),
      )
      .innerJoin(
        schema.workers,
        and(
          eq(schema.workers.id, schema.cantripOsInstances.workerId),
          eq(schema.workers.ownerId, ownerId),
          isNull(schema.workers.unlinkedAt),
        ),
      )
      .where(
        and(
          eq(schema.cantripOsSourceBindings.id, input.sourceBindingId),
          eq(schema.cantripOsSourceBindings.ownerId, ownerId),
          eq(schema.cantripOsSourceBindings.projectId, projectId),
          eq(schema.cantripOsSourceBindings.mode, "linux-owned"),
          isNull(schema.cantripOsSourceBindings.retiredAt),
        ),
      )
      .for("update");
    if (!parent)
      throw new CantripOsPlacementError(
        "The selected Linux-owned Git source is unavailable.",
      );
    const [existing] = await tx
      .select()
      .from(schema.cantripOsSourceBindings)
      .where(eq(schema.cantripOsSourceBindings.id, input.operationId));
    if (existing) {
      if (
        existing.ownerId !== ownerId ||
        existing.projectId !== projectId ||
        existing.projectSourceId !== parent.source.id ||
        existing.workspaceId !== parent.workspace.id ||
        existing.workerId !== parent.instance.workerId ||
        existing.mode !== "linux-owned" ||
        existing.retiredAt ||
        existing.guestPath !==
          `${parent.workspace.homeGuestPath}/worktrees/${existing.worktreeId}`
      )
        throw new CantripOsPlacementError(
          "This worktree admission belongs to a different source or workspace.",
        );
      return { row: existing, instanceId: parent.instance.id };
    }
    if (
      parent.instance.status !== "connected" ||
      parent.instance.runtimeGeneration !== input.expectedRuntimeGeneration ||
      parent.binding.state !== "ready" ||
      parent.binding.provisionedRuntimeGeneration !==
        input.expectedRuntimeGeneration ||
      parent.binding.provisionedAttachmentGeneration !==
        parent.instance.attachmentGeneration
    )
      throw new CantripOsPlacementError(
        "Verify this Linux source in its current runtime before creating a worktree.",
      );
    const worktreeId = randomUUID();
    const guestPath = `${parent.workspace.homeGuestPath}/worktrees/${worktreeId}`;
    await tx.insert(schema.projectWorktrees).values({
      id: worktreeId,
      projectSourceId: parent.source.id,
      workerId: parent.instance.workerId,
      locationKind: "cantrip-os",
      guestPath,
      displayPath: worktreeId,
      rootKind: "git-worktree",
      name: `Linux worktree ${worktreeId.slice(0, 8)}`,
      isPrimary: false,
      isDefault: false,
      origin: "cantrip",
      lifecycleState: "creating",
    });
    const [row] = await tx
      .insert(schema.cantripOsSourceBindings)
      .values({
        id: input.operationId,
        ownerId,
        projectId,
        workerId: parent.instance.workerId,
        projectSourceId: parent.source.id,
        worktreeId,
        workspaceId: parent.workspace.id,
        mode: "linux-owned",
        guestPath,
        bindingGeneration: randomUUID(),
        state: "provisioning",
      })
      .returning();
    return { row: row!, instanceId: parent.instance.id };
  });
}
