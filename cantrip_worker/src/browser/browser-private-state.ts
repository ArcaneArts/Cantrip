import {
  browserPrivateStateProtectedContentSchema,
  type SurfacePrivateStateOpaque,
} from "@cantrip/protocol/surface-private-state";

import {
  decodeSurfacePrivateStateForWorker,
  encodeSurfacePrivateStateForWorker,
} from "../surface-private-state-encryption.js";
import type { WorkerEncryptionService } from "../worker-encryption.js";
import type { RemoteSurfacePrivateState } from "../remote-surface-manager.js";

export type BrowserPersistentStateResource =
  "browser-row" | "browser-remote-surface";

export interface BrowserPersistentPrivateState {
  serverId: string;
  stateProtection: SurfacePrivateStateOpaque;
  stateResource: RemoteSurfacePrivateState["stateResource"];
  stateRevision: number;
}

export class BrowserNavigationOperationGuard {
  readonly #seen = new Set<string>();

  accept(input: {
    expectedRevision: number;
    operationId: string;
    revision: number;
  }): void {
    if (this.#seen.has(input.operationId)) {
      throw new Error("Browser navigation operation was already applied.");
    }
    if (input.revision !== input.expectedRevision) {
      throw new Error("Browser navigation operation is stale.");
    }
    this.#seen.add(input.operationId);
    if (this.#seen.size > 1_000) {
      this.#seen.delete(this.#seen.values().next().value!);
    }
  }
}

export async function openBrowserPersistentPrivateState(input: {
  ownerId: string;
  service: WorkerEncryptionService;
  surfaceId: string;
  state: BrowserPersistentPrivateState;
}): Promise<{ revision: number; url: string }> {
  if (
    input.state.stateResource !== "browser-row" &&
    input.state.stateResource !== "browser-remote-surface"
  ) {
    throw new Error("Browser private state has the wrong resource.");
  }
  const content = browserPrivateStateProtectedContentSchema.parse(
    await decodeSurfacePrivateStateForWorker({
      ownerId: input.ownerId,
      context: {
        serverId: input.state.serverId,
        resource: input.state.stateResource,
        resourceId: input.surfaceId,
        operationId: null,
        recordKind: "browser-state",
      },
      opaque: input.state.stateProtection,
      service: input.service,
    }),
  );
  if (content.revision !== input.state.stateRevision) {
    throw new Error("Browser private state revision is stale.");
  }
  return { revision: content.revision, url: content.url };
}

export async function openBrowserNavigationOperation(input: {
  operationId: string;
  ownerId: string;
  serverId: string;
  service: WorkerEncryptionService;
  stateProtection: SurfacePrivateStateOpaque;
  surfaceId: string;
}): Promise<{ revision: number; url: string }> {
  const content = browserPrivateStateProtectedContentSchema.parse(
    await decodeSurfacePrivateStateForWorker({
      ownerId: input.ownerId,
      context: {
        serverId: input.serverId,
        resource: "browser-operation",
        resourceId: input.surfaceId,
        operationId: input.operationId,
        recordKind: "browser-state",
      },
      opaque: input.stateProtection,
      service: input.service,
    }),
  );
  return { revision: content.revision, url: content.url };
}

export async function protectBrowserLocationOperation(input: {
  operationId: string;
  ownerId: string;
  revision: number;
  serverId: string;
  service: WorkerEncryptionService;
  surfaceId: string;
  url: string;
}): Promise<SurfacePrivateStateOpaque> {
  return encodeSurfacePrivateStateForWorker({
    ownerId: input.ownerId,
    context: {
      serverId: input.serverId,
      resource: "browser-operation",
      resourceId: input.surfaceId,
      operationId: input.operationId,
      recordKind: "browser-state",
    },
    content: {
      version: 1,
      classification: { recordKind: "browser-state" },
      revision: input.revision,
      url: input.url,
    },
    service: input.service,
  });
}
