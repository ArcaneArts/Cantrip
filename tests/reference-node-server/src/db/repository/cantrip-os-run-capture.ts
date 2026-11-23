import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  cantripOsRunRootsSchema,
  type CantripOsRunRoots,
} from "@cantrip/protocol";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsRepository, CantripOsPlacementError } from "./cantrip-os.js";
import { cantripOsExecutionForSource } from "./cantrip-os-chats.js";

/** Ordered IDs/generations form a portable epoch across both Server implementations.
 * Paths remain in their separate immutable capture, never in Worker path fields. */
export function osRunExecutionKey(roots: CantripOsRunRoots): string {
  const d = roots.definitions.scope,
    t = roots.target.scope;
  const epoch = [
    t.ownerId,
    t.projectId,
    t.projectSourceId,
    t.workerId,
    t.instanceId,
    t.workspaceId,
    d.bindingId,
    d.bindingGeneration,
    t.bindingId,
    t.bindingGeneration,
    t.attachmentGeneration,
    t.runtimeGeneration,
  ];
  return `cantrip-os:${createHash("sha256").update(JSON.stringify(epoch)).digest("hex")}`;
}

export async function captureOsRunAdmission(
  database: RepositoryDatabase,
  ownerId: string,
  input: {
    projectId: string;
    worktreeId: string;
    workerId: string;
    osExecution?: CantripOsRunRoots;
  },
) {
  if (!input.osExecution) return null;
  const roots = cantripOsRunRootsSchema.parse(input.osExecution),
    t = roots.target.scope;
  if (
    t.ownerId !== ownerId ||
    t.projectId !== input.projectId ||
    t.worktreeId !== input.worktreeId ||
    t.workerId !== input.workerId
  )
    throw new CantripOsPlacementError(
      "The Linux Run does not match its owned target.",
    );
  const repository = new CantripOsRepository(database);
  const definitions = await repository.runPrimary(
    ownerId,
    input.projectId,
    t.bindingId,
    t.runtimeGeneration,
  );
  const source = await repository.executionContext(ownerId, t.bindingId, {
    bindingGeneration: t.bindingGeneration,
    attachmentGeneration: t.attachmentGeneration,
    runtimeGeneration: t.runtimeGeneration,
  });
  const target = cantripOsExecutionForSource(ownerId, source, t);
  if (!isDeepStrictEqual(roots, { definitions, target }))
    throw new CantripOsPlacementError(
      "The Linux Run placement changed before admission; no host fallback was attempted.",
    );
  return roots;
}
