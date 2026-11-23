import type { CantripOsExecution } from "@cantrip/protocol";
import type { RepositoryDatabase } from "./database.js";
import { CantripOsRepository, CantripOsPlacementError } from "./cantrip-os.js";
import { cantripOsExecutionForSource } from "./cantrip-os-chats.js";
import { requireWorkerLocalPath } from "./worker-local-source-path.js";

export interface OsFileCapture {
  cantripOsBindingId: string | null;
  osBindingGeneration: string | null;
  osAttachmentGeneration: string | null;
  osRuntimeGeneration: string | null;
}

/** Product resources capture an explicit source. A linked worktree can also be
 * used on the host, so its worktree ID alone must never choose Linux execution. */
export class CantripOsFileRepository {
  constructor(private readonly database: RepositoryDatabase) {}
  async capture(
    ownerId: string,
    projectId: string,
    worktreeId: string,
    bindingId: string,
    expectedRuntimeGeneration: string | undefined,
  ): Promise<OsFileCapture> {
    const source = await new CantripOsRepository(this.database).bindingContext(
      ownerId,
      bindingId,
    );
    if (
      !source?.available ||
      source.binding.projectId !== projectId ||
      source.binding.worktreeId !== worktreeId ||
      !source.instance.runtimeGeneration ||
      source.instance.runtimeGeneration !== expectedRuntimeGeneration
    )
      throw new CantripOsPlacementError(
        "The selected OS file source is unavailable or belongs to another worktree.",
      );
    return {
      cantripOsBindingId: bindingId,
      osBindingGeneration: source.binding.bindingGeneration,
      osAttachmentGeneration: source.instance.attachmentGeneration,
      osRuntimeGeneration: source.instance.runtimeGeneration,
    };
  }
  async root(
    ownerId: string,
    projectId: string,
    worktree: {
      id: string;
      workerId: string;
      absolutePath: string | null;
      locationKind: string;
    },
    capture: OsFileCapture,
  ): Promise<string | CantripOsExecution> {
    if (!capture.cantripOsBindingId) {
      if (worktree.locationKind !== "worker-local")
        throw new CantripOsPlacementError(
          "This Linux source requires an explicit file placement; no host fallback was attempted.",
        );
      return requireWorkerLocalPath(worktree.absolutePath);
    }
    if (
      !capture.osBindingGeneration ||
      !capture.osAttachmentGeneration ||
      !capture.osRuntimeGeneration
    )
      throw new CantripOsPlacementError(
        "The file source capture is incomplete.",
      );
    const generations = {
      bindingGeneration: capture.osBindingGeneration,
      attachmentGeneration: capture.osAttachmentGeneration,
      runtimeGeneration: capture.osRuntimeGeneration,
    };
    const source = await new CantripOsRepository(
      this.database,
    ).executionContext(ownerId, capture.cantripOsBindingId, generations);
    if (
      source.binding.projectId !== projectId ||
      source.binding.worktreeId !== worktree.id ||
      source.instance.workerId !== worktree.workerId
    )
      throw new CantripOsPlacementError(
        "The file resource differs from its captured OS source; no host fallback was attempted.",
      );
    return cantripOsExecutionForSource(ownerId, source, generations);
  }
}
