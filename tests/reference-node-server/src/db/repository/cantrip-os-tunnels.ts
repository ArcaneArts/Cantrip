import type { TunnelWireSummary } from "@cantrip/protocol";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsRepository, CantripOsPlacementError } from "./cantrip-os.js";
import { cantripOsExecutionForSource } from "./cantrip-os-chats.js";

export async function resolveOsTunnelExecution(
  database: RepositoryDatabase,
  ownerId: string,
  projectId: string | null,
  workerId: string,
  capture: NonNullable<TunnelWireSummary["osSource"]>,
) {
  const source = await new CantripOsRepository(database).executionContext(
    ownerId,
    capture.bindingId,
    capture,
  );
  if (
    !projectId ||
    source.binding.projectId !== projectId ||
    source.binding.worktreeId !== capture.worktreeId ||
    source.instance.workerId !== workerId
  )
    throw new CantripOsPlacementError(
      "The tunnel differs from its captured OS source; no Host fallback was attempted.",
    );
  return cantripOsExecutionForSource(ownerId, source, capture);
}
