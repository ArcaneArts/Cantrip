import {
  remoteDesktopPrivateInventoryProtectedContentSchema,
  remoteDesktopPrivateStateProtectedContentSchema,
  type SurfacePrivateStateOpaque,
} from "@cantrip/protocol/surface-private-state";
import type {
  RemoteDesktopTarget,
  RemoteDesktopTargetInventory,
} from "@cantrip/protocol";

import type { RemoteSurfacePrivateState } from "../remote-surface-manager.js";
import {
  decodeSurfacePrivateStateForWorker,
  encodeSurfacePrivateStateForWorker,
} from "../surface-private-state-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";

export class RemoteDesktopOperationGuard {
  readonly #seen = new Set<string>();

  accept(operationId: string): void {
    if (this.#seen.has(operationId)) {
      throw new Error("Remote Desktop private-state operation was replayed.");
    }
    this.#seen.add(operationId);
    if (this.#seen.size > 1_000) {
      this.#seen.delete(this.#seen.values().next().value!);
    }
  }
}

export async function openRemoteDesktopPersistentPrivateState(input: {
  ownerId: string;
  service: WorkerEncryptionService;
  surfaceId: string;
  state: RemoteSurfacePrivateState;
}): Promise<RemoteDesktopTarget> {
  if (
    input.state.stateResource !== "remote-desktop-row" &&
    input.state.stateResource !== "remote-desktop-surface"
  ) {
    throw new Error("Remote Desktop private state has the wrong resource.");
  }
  const content = remoteDesktopPrivateStateProtectedContentSchema.parse(
    await decodeSurfacePrivateStateForWorker({
      ownerId: input.ownerId,
      context: {
        serverId: input.state.serverId,
        resource: input.state.stateResource,
        resourceId: input.surfaceId,
        operationId: null,
        recordKind: "remote-desktop-state",
      },
      opaque: input.state.stateProtection,
      service: input.service,
    }),
  );
  if (content.revision !== input.state.stateRevision) {
    throw new Error("Remote Desktop private state revision is stale.");
  }
  return content.target;
}

export async function protectRemoteDesktopInventoryOperation(input: {
  active: RemoteDesktopTarget | null;
  inventory: RemoteDesktopTargetInventory;
  launchingApplication: string | null;
  message: string | null;
  operationId: string;
  ownerId: string;
  requested: RemoteDesktopTarget | null;
  resourceId: string;
  serverId: string;
  service: WorkerEncryptionService;
}): Promise<SurfacePrivateStateOpaque> {
  const content = remoteDesktopPrivateInventoryProtectedContentSchema.parse({
    version: 1,
    classification: { recordKind: "remote-desktop-inventory" },
    monitors: input.inventory.monitors,
    windows: input.inventory.windows,
    requested: input.requested,
    active: input.active,
    launchingApplication: input.launchingApplication,
    message: input.message,
  });
  return encodeSurfacePrivateStateForWorker({
    ownerId: input.ownerId,
    context: {
      serverId: input.serverId,
      resource: "remote-desktop-inventory",
      resourceId: input.resourceId,
      operationId: input.operationId,
      recordKind: "remote-desktop-inventory",
    },
    content,
    service: input.service,
  });
}
