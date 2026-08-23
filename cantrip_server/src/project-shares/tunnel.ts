import {
  projectShareAttachmentWireSchema,
  workerProjectShareOpenResultSchema,
  type ProjectShareAttachmentWire,
} from "@cantrip/protocol";
import type { ProtectedTunnelContentRecord } from "@cantrip/protocol/tunnel-content";

import type { ServerRepository } from "../db/repository.js";
import { serverLogger } from "../logger.js";
import type { TunnelStreamBroker } from "../tunnels/broker.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

export interface OpenProjectShareInput {
  ownerId: string;
  projectId: string;
  protectedRecord: ProtectedTunnelContentRecord;
  tunnelId: string;
  workerId: string;
}

export interface ProjectShareTunnelBrokerOptions {
  maxLifetimeMs?: number;
  surfaceOrigin?: string;
}

type ProjectShareTunnelChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}) => void;

interface ActiveShare {
  ownerId: string;
  projectId: string;
  tunnelId: string;
  workerId: string;
}

const WORKER_SHARE_COMMAND_TIMEOUT_MS = 30_000;
const WORKER_SHARE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_NATIVE_MOUNT_LEASE_MS = 24 * 60 * 60_000;
const DEFAULT_MOUNT_LEASE_MS = 12 * 60 * 60_000;

/**
 * Project-share control plane. The server retains only authenticated routing
 * metadata and opaque tunnel content. WebDAV paths, roots, credentials, and
 * payloads are opened exclusively by the unlocked client and assigned worker.
 */
export class ProjectShareTunnelBroker {
  readonly #active = new Map<string, ActiveShare>();
  readonly #maxLifetimeMs: number;
  #changed: ProjectShareTunnelChange | null = null;
  #repository: ServerRepository | null = null;

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: ProjectShareTunnelBrokerOptions = {},
  ) {
    this.#maxLifetimeMs = options.maxLifetimeMs ?? DEFAULT_MOUNT_LEASE_MS;
    if (
      !Number.isFinite(this.#maxLifetimeMs) ||
      this.#maxLifetimeMs <= 0 ||
      this.#maxLifetimeMs > MAX_NATIVE_MOUNT_LEASE_MS
    ) {
      throw new Error(
        "Project share maximum lifetime must be between 1 ms and 24 hours.",
      );
    }
  }

  configureControlPlane(
    repository: ServerRepository,
    _streamBroker: TunnelStreamBroker,
    changed: ProjectShareTunnelChange,
  ): void {
    if (this.#repository) {
      throw new Error("Project share control plane is already configured.");
    }
    this.#repository = repository;
    this.#changed = changed;
  }

  async open(
    input: OpenProjectShareInput,
  ): Promise<ProjectShareAttachmentWire> {
    const startedAtMs = Date.now();
    const repository = this.#requiredRepository();
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error(`Worker ${input.workerId} is offline.`);
    }
    const managedBy = { kind: "project-share" as const, id: input.projectId };
    const existing = await repository.getManagedTunnel(
      input.ownerId,
      managedBy,
    );
    if (existing && existing.id !== input.tunnelId) {
      throw new Error("Project share tunnel identity is stale.");
    }
    if (
      (!existing &&
        (input.protectedRecord.revision !== 1 ||
          input.protectedRecord.operationId !== input.tunnelId)) ||
      (existing &&
        (!existing.protectedRecord ||
          input.protectedRecord.revision !==
            existing.protectedRecord.revision + 1 ||
          input.protectedRecord.operationId ===
            existing.protectedRecord.operationId))
    ) {
      throw new Error("Project share protected content is stale.");
    }

    if (existing) {
      await this.#closeWorkerShare(existing.id, existing.destination.workerId);
    }
    const rawResult = await this.bridge.request(
      input.workerId,
      {
        type: "project.share.open",
        shareId: input.tunnelId,
        protectedRecord: input.protectedRecord,
      },
      { timeoutMs: WORKER_SHARE_COMMAND_TIMEOUT_MS },
    );
    const result = workerProjectShareOpenResultSchema.parse(rawResult);
    if (result.shareId !== input.tunnelId) {
      throw new Error("Worker opened an unexpected project share.");
    }

    try {
      const tunnel = await repository.registerManagedTunnel(
        input.ownerId,
        {
          name: "Project files",
          description: "Secure WebDAV access to this project's files.",
          projectId: input.projectId,
          origin: "project-share",
          management: "managed-ephemeral",
          protocolHint: "webdav",
          source: { kind: "desktop-loopback" },
          destination: {
            kind: "worker-adapter",
            workerId: input.workerId,
            adapter: "project-share",
            resourceId: input.tunnelId,
          },
          managedBy,
          desiredState: "started",
          status: "starting",
        },
        {
          id: input.tunnelId,
          protectedRecord: input.protectedRecord,
        },
      );
      if (!tunnel) {
        throw new Error("Could not register the project share tunnel.");
      }
      this.#active.set(tunnel.id, {
        ownerId: input.ownerId,
        projectId: input.projectId,
        tunnelId: tunnel.id,
        workerId: input.workerId,
      });
      this.#changed?.({
        attachmentId: tunnel.id,
        ownerId: input.ownerId,
        projectId: input.projectId,
        tunnelId: tunnel.id,
      });
      serverLogger.info("Protected project share ready", {
        event: "project_share.open.completed",
        subsystem: "project-share",
        operation: "open",
        status: "completed",
        attachmentId: tunnel.id,
        projectId: input.projectId,
        tunnelId: tunnel.id,
        workerId: input.workerId,
        durationMs: Date.now() - startedAtMs,
      });
      return projectShareAttachmentWireSchema.parse({
        attachmentId: tunnel.id,
        projectId: input.projectId,
        protocol: "webdav",
        tunnelId: tunnel.id,
        expiresAt: new Date(Date.now() + this.#maxLifetimeMs).toISOString(),
        mountLeaseMs: this.#maxLifetimeMs,
      });
    } catch (error) {
      await this.#closeWorkerShare(input.tunnelId, input.workerId);
      throw error;
    }
  }

  async revokeAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    const repository = this.#requiredRepository();
    const tunnel = await repository.getTunnel(ownerId, attachmentId);
    if (
      !tunnel ||
      tunnel.origin !== "project-share" ||
      tunnel.managedBy?.kind !== "project-share"
    ) {
      return false;
    }
    await this.#closeWorkerShare(tunnel.id, tunnel.destination.workerId);
    const removed = await repository.removeManagedTunnel(
      ownerId,
      tunnel.managedBy,
    );
    this.#active.delete(tunnel.id);
    if (removed) {
      this.#changed?.({
        attachmentId: tunnel.id,
        ownerId,
        projectId: tunnel.projectId,
        tunnelId: tunnel.id,
      });
    }
    return removed;
  }

  async revokeProject(projectId: string, ownerId: string): Promise<boolean> {
    const repository = this.#requiredRepository();
    const managedBy = { kind: "project-share" as const, id: projectId };
    const tunnel = await repository.getManagedTunnel(ownerId, managedBy);
    if (!tunnel) return false;
    await this.#closeWorkerShare(tunnel.id, tunnel.destination.workerId);
    const removed = await repository.removeManagedTunnel(ownerId, managedBy);
    this.#active.delete(tunnel.id);
    return removed;
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...this.#active.values()].map((share) =>
        this.#closeWorkerShare(share.tunnelId, share.workerId),
      ),
    );
    this.#active.clear();
  }

  #requiredRepository(): ServerRepository {
    if (!this.#repository) {
      throw new Error("Project share control plane is not configured.");
    }
    return this.#repository;
  }

  async #closeWorkerShare(shareId: string, workerId: string): Promise<void> {
    if (!this.bridge.isConnected(workerId)) return;
    await this.bridge
      .request(
        workerId,
        { type: "project.share.close", shareId },
        { timeoutMs: WORKER_SHARE_CLOSE_TIMEOUT_MS },
      )
      .catch(() => undefined);
  }
}
