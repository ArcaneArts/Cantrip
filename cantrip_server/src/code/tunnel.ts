import {
  type CodeProtectedAttachmentWire,
  type CodeRuntimeStatus,
  type ProtectedTunnelContentRecord,
} from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";
import { serverLogger } from "../logger.js";
import type { WorkerCommandBus } from "../workers/bridge.js";

interface ProtectedCodeAttachmentBinding {
  attachmentId: string;
  authSessionId: string | null;
  codeTabId: string;
  createdAt: number;
  expiresAt: number;
  ownerId: string;
  projectId: string;
  sessionId: string;
  stopSessionOnRelease: boolean;
  tunnelId: string;
  workerId: string;
}

export interface CreateProtectedCodeAttachmentInput {
  authSessionId?: string | null;
  codeTabId: string;
  ownerId: string;
  projectId: string;
  protectedRecord: ProtectedTunnelContentRecord;
  runtime: CodeRuntimeStatus;
  sessionId: string;
  stopSessionOnRelease?: boolean;
  tunnelId: string;
  workerId: string;
}

export interface CodeTunnelBrokerOptions {
  idleTtlMs?: number;
  maxAttachments?: number;
  maxLifetimeMs?: number;
}

type CleanupTunnelResources = (
  ownerId: string,
  tunnelId: string,
  reason: string,
  code?: number,
) => Promise<void> | void;

type CodeTunnelChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}) => void;

export class CodeTunnelBroker {
  readonly #attachments = new Map<string, ProtectedCodeAttachmentBinding>();
  readonly #idleTtlMs: number;
  readonly #maxAttachments: number;
  readonly #maxLifetimeMs: number;
  readonly #removals = new Map<string, Promise<boolean>>();
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  readonly #workerDisconnectSubscriptions = new Map<string, () => void>();
  #changed: CodeTunnelChange | null = null;
  #cleanupTunnelResources: CleanupTunnelResources | null = null;
  #repository: ServerRepository | null = null;

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: CodeTunnelBrokerOptions = {},
  ) {
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxAttachments = options.maxAttachments ?? 128;
    this.#sweepTimer = setInterval(
      () => this.#prune(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  configureControlPlane(
    repository: ServerRepository,
    changed: CodeTunnelChange,
    cleanupTunnelResources?: CleanupTunnelResources,
  ): void {
    if (this.#attachments.size > 0) {
      throw new Error("Code control plane must be configured before use.");
    }
    this.#repository = repository;
    this.#changed = changed;
    this.#cleanupTunnelResources = cleanupTunnelResources ?? null;
  }

  async createProtectedAttachment(
    input: CreateProtectedCodeAttachmentInput,
  ): Promise<CodeProtectedAttachmentWire> {
    this.#prune();
    if (this.#attachments.size >= this.#maxAttachments) {
      throw new Error(
        "This server has reached its Cantrip Code attachment limit.",
      );
    }
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error("Cantrip Code worker is offline.");
    }
    if (!this.#repository) {
      throw new Error("Cantrip Code protected control plane is unavailable.");
    }
    const tunnel = await this.#repository.registerManagedTunnel(
      input.ownerId,
      {
        name: "Cantrip Code",
        description: "Protected editor access for the owning Code surface.",
        projectId: input.projectId,
        origin: "code",
        management: "managed-ephemeral",
        protocolHint: "http-websocket",
        source: { kind: "desktop-loopback" },
        destination: {
          kind: "worker-adapter",
          workerId: input.workerId,
          adapter: "code",
          resourceId: input.tunnelId,
        },
        managedBy: { kind: "code", id: input.tunnelId },
        desiredState: "started",
        status: "starting",
      },
      { id: input.tunnelId, protectedRecord: input.protectedRecord },
    );
    if (!tunnel || tunnel.id !== input.tunnelId) {
      throw new Error("Could not register the protected Code tunnel.");
    }
    const now = Date.now();
    const binding: ProtectedCodeAttachmentBinding = {
      attachmentId: tunnel.id,
      authSessionId: input.authSessionId ?? null,
      codeTabId: input.codeTabId,
      createdAt: now,
      expiresAt: now + this.#idleTtlMs,
      ownerId: input.ownerId,
      projectId: input.projectId,
      sessionId: input.sessionId,
      stopSessionOnRelease: input.stopSessionOnRelease ?? false,
      tunnelId: tunnel.id,
      workerId: input.workerId,
    };
    this.#attachments.set(binding.attachmentId, binding);
    this.#trackWorkerDisconnect(binding.workerId);
    this.#changed?.({
      attachmentId: binding.attachmentId,
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      tunnelId: binding.tunnelId,
    });
    serverLogger.info("Protected Cantrip Code attachment created", {
      attachmentId: binding.attachmentId,
      codeTabId: binding.codeTabId,
      sessionId: binding.sessionId,
      tunnelId: binding.tunnelId,
      workerId: binding.workerId,
    });
    return {
      attachmentId: binding.attachmentId,
      tunnelId: binding.tunnelId,
      sessionId: binding.sessionId,
      expiresAt: new Date(binding.expiresAt).toISOString(),
      runtime: input.runtime,
    };
  }

  async revokeAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    const binding = this.#attachments.get(attachmentId);
    if (!binding || binding.ownerId !== ownerId) return false;
    return this.#removeAttachment(binding);
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.#revokeWhere((binding) => binding.sessionId === sessionId);
  }

  async revokeAuthSession(authSessionId: string): Promise<void> {
    await this.#revokeWhere(
      (binding) => binding.authSessionId === authSessionId,
    );
  }

  async revokeOwner(ownerId: string): Promise<void> {
    await this.#revokeWhere((binding) => binding.ownerId === ownerId);
  }

  async close(): Promise<void> {
    clearInterval(this.#sweepTimer);
    const bindings = [...this.#attachments.values()];
    const removals = await Promise.allSettled(
      bindings.map((binding) => this.#removeAttachment(binding)),
    );
    removals.forEach((result, index) => {
      if (result.status === "rejected") {
        this.#reportCleanupFailure(bindings[index]!, result.reason);
      }
    });
    for (const unsubscribe of this.#workerDisconnectSubscriptions.values()) {
      unsubscribe();
    }
    this.#workerDisconnectSubscriptions.clear();
  }

  #prune(): void {
    const now = Date.now();
    for (const binding of this.#attachments.values()) {
      if (
        binding.expiresAt <= now ||
        binding.createdAt + this.#maxLifetimeMs <= now
      ) {
        void this.#removeAttachment(binding).catch((error) =>
          this.#reportCleanupFailure(binding, error),
        );
      }
    }
  }

  async #removeAttachment(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<boolean> {
    if (this.#attachments.get(binding.attachmentId) !== binding) return false;
    const pending = this.#removals.get(binding.attachmentId);
    if (pending) return pending;
    const removal = this.#removeOwnedAttachment(binding).finally(() => {
      if (this.#removals.get(binding.attachmentId) === removal) {
        this.#removals.delete(binding.attachmentId);
      }
    });
    this.#removals.set(binding.attachmentId, removal);
    return removal;
  }

  async #removeOwnedAttachment(
    binding: ProtectedCodeAttachmentBinding,
  ): Promise<boolean> {
    if (!this.#repository) {
      throw new Error("Cantrip Code protected control plane is unavailable.");
    }
    await Promise.all([
      this.#cleanupTunnelResources?.(
        binding.ownerId,
        binding.tunnelId,
        "Code attachment revoked",
        1008,
      ),
      this.bridge.isConnected(binding.workerId)
        ? this.bridge
            .request(
              binding.workerId,
              { type: "code.endpoint.revoke", tunnelId: binding.tunnelId },
              { timeoutMs: 5_000 },
            )
            .catch(() => undefined)
        : Promise.resolve(),
    ]);
    await this.#repository.removeManagedTunnel(binding.ownerId, {
      kind: "code",
      id: binding.tunnelId,
    });
    this.#attachments.delete(binding.attachmentId);
    this.#changed?.({
      attachmentId: binding.attachmentId,
      ownerId: binding.ownerId,
      projectId: binding.projectId,
      tunnelId: binding.tunnelId,
    });
    if (binding.stopSessionOnRelease) {
      await this.bridge
        .request(
          binding.workerId,
          {
            type: "code.stop",
            sessionId: binding.sessionId,
          },
          { timeoutMs: 5_000 },
        )
        .catch(() => undefined);
    }
    this.#stopTrackingWorkerIfUnused(binding.workerId);
    return true;
  }

  async #revokeWhere(
    predicate: (binding: ProtectedCodeAttachmentBinding) => boolean,
  ): Promise<void> {
    await Promise.all(
      [...this.#attachments.values()]
        .filter(predicate)
        .map((binding) => this.#removeAttachment(binding)),
    );
  }

  #trackWorkerDisconnect(workerId: string): void {
    if (this.#workerDisconnectSubscriptions.has(workerId)) return;
    const unsubscribe = this.bridge.subscribeWorkerDisconnect(workerId, () => {
      for (const binding of [...this.#attachments.values()]) {
        if (binding.workerId !== workerId) continue;
        void this.#removeAttachment(binding).catch((error) =>
          this.#reportCleanupFailure(binding, error),
        );
      }
      this.#stopTrackingWorkerIfUnused(workerId);
    });
    this.#workerDisconnectSubscriptions.set(workerId, unsubscribe);
  }

  #stopTrackingWorkerIfUnused(workerId: string): void {
    if (
      [...this.#attachments.values()].some(
        (binding) => binding.workerId === workerId,
      )
    )
      return;
    this.#workerDisconnectSubscriptions.get(workerId)?.();
    this.#workerDisconnectSubscriptions.delete(workerId);
  }

  #reportCleanupFailure(
    binding: ProtectedCodeAttachmentBinding,
    error: unknown,
  ): void {
    serverLogger.warn("Protected Cantrip Code cleanup failed", {
      event: "code.attachment.cleanup-failed",
      subsystem: "code",
      operation: "revoke-attachment",
      reasonCode: "managed-tunnel-cleanup-failed",
      status: "failed",
      attachmentId: binding.attachmentId,
      codeTabId: binding.codeTabId,
      sessionId: binding.sessionId,
      tunnelId: binding.tunnelId,
      workerId: binding.workerId,
      errorClass: error instanceof Error ? error.name : "Error",
    });
  }
}
