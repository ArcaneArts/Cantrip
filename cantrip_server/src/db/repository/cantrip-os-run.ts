import { and, eq, isNull } from "drizzle-orm";
import * as schema from "../schema.js";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsPlacementError } from "./cantrip-os-error.js";
import type { CantripOsRepository } from "./cantrip-os.js";
import { cantripOsExecutionForSource } from "./cantrip-os-chats.js";

/** A selected source/workspace resolves its own Primary. Neither the active
 * chat nor the project's default host replica participates in this choice. */
export async function resolveOsRunPrimary(
  database: RepositoryDatabase,
  repository: CantripOsRepository,
  ownerId: string,
  projectId: string,
  bindingId: string,
  runtimeGeneration: string,
) {
  const selected = await repository.bindingContext(ownerId, bindingId);
  if (
    !selected?.available ||
    selected.binding.projectId !== projectId ||
    selected.instance.runtimeGeneration !== runtimeGeneration
  )
    throw new CantripOsPlacementError(
      "The selected Linux Run source changed or is unavailable; no host fallback was attempted.",
    );
  const candidates = await database
    .select({ id: schema.cantripOsSourceBindings.id })
    .from(schema.cantripOsSourceBindings)
    .innerJoin(
      schema.projectWorktrees,
      and(
        eq(
          schema.projectWorktrees.id,
          schema.cantripOsSourceBindings.worktreeId,
        ),
        eq(
          schema.projectWorktrees.projectSourceId,
          selected.binding.projectSourceId,
        ),
        eq(schema.projectWorktrees.isPrimary, true),
      ),
    )
    .where(
      and(
        eq(schema.cantripOsSourceBindings.ownerId, ownerId),
        eq(schema.cantripOsSourceBindings.projectId, projectId),
        eq(
          schema.cantripOsSourceBindings.projectSourceId,
          selected.binding.projectSourceId,
        ),
        eq(schema.cantripOsSourceBindings.workspaceId, selected.workspace.id),
        isNull(schema.cantripOsSourceBindings.retiredAt),
      ),
    );
  if (candidates.length !== 1)
    throw new CantripOsPlacementError(
      "This Linux source needs one explicitly bound Primary in the selected workspace.",
    );
  const primary = await repository.bindingContext(ownerId, candidates[0]!.id);
  if (
    !primary?.available ||
    primary.instance.runtimeGeneration !== runtimeGeneration ||
    primary.instance.id !== selected.instance.id ||
    primary.instance.attachmentGeneration !==
      selected.instance.attachmentGeneration
  )
    throw new CantripOsPlacementError(
      "The selected Linux source's Primary is unavailable; no host fallback was attempted.",
    );
  return cantripOsExecutionForSource(ownerId, primary, {
    bindingGeneration: primary.binding.bindingGeneration,
    attachmentGeneration: primary.instance.attachmentGeneration,
    runtimeGeneration,
  });
}
