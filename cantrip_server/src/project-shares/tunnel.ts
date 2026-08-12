import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  type ProjectShareAttachment,
  projectShareAttachmentSchema,
  projectSharePublicOriginSchema,
  workerProjectShareOpenResultSchema,
} from "@cantrip/protocol";

import type { ServerRepository } from "../db/repository.js";
import {
  TunnelStreamBroker,
  type TunnelRouteHandle,
} from "../tunnels/broker.js";
import { ManagedServerRelayTelemetry } from "../tunnels/managed-relay-telemetry.js";
import { WorkerTunnelEndpoint } from "../tunnels/worker-endpoint.js";
import type { WorkerCommandBus } from "../workers/bridge.js";
import { ProjectShareHttpEndpoint } from "./http-endpoint.js";

export interface ProjectShareAttachmentBinding {
  attachment: ProjectShareAttachment;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ownerId: string;
  publicBasePath: string;
  root: string;
  route: TunnelRouteHandle;
  source: ProjectShareHttpEndpoint;
  telemetry: ManagedServerRelayTelemetry | null;
  token: string;
  tunnelId: string;
  workerId: string;
}

export interface OpenProjectShareInput {
  ownerId: string;
  projectId: string;
  root: string;
  workerId: string;
}

export interface ProjectShareTunnelBrokerOptions {
  idleTtlMs?: number;
  maxAttachments?: number;
  maxLifetimeMs?: number;
  surfaceOrigin: string;
}

type ProjectShareTunnelChange = (input: {
  attachmentId: string;
  ownerId: string;
  projectId: string | null;
  tunnelId: string;
}) => void;

const WORKER_SHARE_COMMAND_TIMEOUT_MS = 30_000;
const WORKER_SHARE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_NATIVE_MOUNT_LEASE_MS = 24 * 60 * 60_000;

function projectKey(input: { ownerId: string; projectId: string }): string {
  return `${input.ownerId}\0${input.projectId}`;
}

export class ProjectShareTunnelBroker {
  readonly #attachments = new Map<string, ProjectShareAttachmentBinding>();
  readonly #attachmentsByProject = new Map<
    string,
    ProjectShareAttachmentBinding
  >();
  readonly #idleTtlMs: number;
  readonly #maxAttachments: number;
  readonly #maxLifetimeMs: number;
  readonly #opening = new Map<string, Promise<ProjectShareAttachment>>();
  readonly #orphanedShareIds = new Map<string, Set<string>>();
  readonly #surfaceOrigin: URL;
  readonly #sweepTimer: ReturnType<typeof setInterval>;
  readonly #workerDisconnectSubscriptions = new Map<string, () => void>();
  #changed: ProjectShareTunnelChange | null = null;
  #ownsStreamBroker = true;
  #repository: ServerRepository | null = null;
  #streamBroker = new TunnelStreamBroker();

  constructor(
    private readonly bridge: WorkerCommandBus,
    options: ProjectShareTunnelBrokerOptions,
  ) {
    this.#surfaceOrigin = new URL(
      projectSharePublicOriginSchema.parse(options.surfaceOrigin),
    );
    this.#idleTtlMs = options.idleTtlMs ?? 15 * 60_000;
    this.#maxLifetimeMs = options.maxLifetimeMs ?? 12 * 60 * 60_000;
    this.#maxAttachments = options.maxAttachments ?? 128;
    if (!Number.isFinite(this.#idleTtlMs) || this.#idleTtlMs <= 0) {
      throw new Error("Project share idle lifetime must be positive.");
    }
    if (
      !Number.isFinite(this.#maxLifetimeMs) ||
      this.#maxLifetimeMs <= 0 ||
      this.#maxLifetimeMs > MAX_NATIVE_MOUNT_LEASE_MS
    ) {
      throw new Error(
        "Project share maximum lifetime must be between 1 ms and 24 hours.",
      );
    }
    if (!Number.isInteger(this.#maxAttachments) || this.#maxAttachments < 1) {
      throw new Error("Project share attachment limit must be positive.");
    }
    this.#sweepTimer = setInterval(
      () => this.#prune(),
      Math.max(1_000, Math.min(60_000, this.#idleTtlMs)),
    );
    this.#sweepTimer.unref();
  }

  configureControlPlane(
    repository: ServerRepository,
    streamBroker: TunnelStreamBroker,
    changed: ProjectShareTunnelChange,
  ): void {
    if (this.#attachments.size > 0 || this.#opening.size > 0) {
      throw new Error(
        "Project share control plane must be configured before use.",
      );
    }
    if (this.#ownsStreamBroker) this.#streamBroker.close();
    this.#repository = repository;
    this.#streamBroker = streamBroker;
    this.#ownsStreamBroker = false;
    this.#changed = changed;
  }

  async open(input: OpenProjectShareInput): Promise<ProjectShareAttachment> {
    this.#prune();
    const key = projectKey(input);
    const opening = this.#opening.get(key);
    if (opening) return opening;

    const existing = this.#attachmentsByProject.get(key);
    if (
      !existing &&
      this.#attachments.size + this.#opening.size >= this.#maxAttachments
    ) {
      throw new Error("This server has reached its project share limit.");
    }
    const pending = this.#openOrReuse(input, existing);
    this.#opening.set(key, pending);
    try {
      return await pending;
    } finally {
      this.#opening.delete(key);
    }
  }

  hasAttachment(token: string): boolean {
    return this.#resolve(token) !== null;
  }

  async revokeAttachment(
    attachmentId: string,
    ownerId: string,
  ): Promise<boolean> {
    for (const binding of this.#attachments.values()) {
      if (
        binding.attachment.attachmentId === attachmentId &&
        binding.ownerId === ownerId
      ) {
        await this.#revoke(binding);
        return true;
      }
    }
    return false;
  }

  async revokeProject(projectId: string, ownerId: string): Promise<boolean> {
    const binding = this.#attachmentsByProject.get(
      projectKey({ ownerId, projectId }),
    );
    if (!binding) return false;
    await this.#revoke(binding);
    return true;
  }

  async close(): Promise<void> {
    clearInterval(this.#sweepTimer);
    await Promise.allSettled(this.#opening.values());
    await Promise.allSettled(
      [...this.#attachments.values()].map((binding) => this.#revoke(binding)),
    );
    await Promise.allSettled(
      [...this.#orphanedShareIds.keys()].map((workerId) =>
        this.#flushOrphanedWorkerShares(workerId),
      ),
    );
    for (const unsubscribe of this.#workerDisconnectSubscriptions.values()) {
      unsubscribe();
    }
    this.#workerDisconnectSubscriptions.clear();
    this.#orphanedShareIds.clear();
    if (this.#ownsStreamBroker) this.#streamBroker.close();
  }

  proxyHttp(
    token: string,
    request: IncomingMessage,
    response: ServerResponse,
  ): void {
    const binding = this.#resolve(token);
    if (!binding || !this.#requestMatchesBinding(request, binding)) {
      response.writeHead(404, { "cache-control": "no-store" }).end("Not found");
      return;
    }
    if (!this.bridge.isConnected(binding.workerId)) {
      response
        .writeHead(503, { "cache-control": "no-store" })
        .end("Worker offline");
      return;
    }
    binding.source.proxy(request, response);
  }

  async #openOrReuse(
    input: OpenProjectShareInput,
    existing: ProjectShareAttachmentBinding | undefined,
  ): Promise<ProjectShareAttachment> {
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error(`Worker ${input.workerId} is offline.`);
    }
    await this.#flushOrphanedWorkerShares(input.workerId);

    if (
      existing &&
      existing.root === input.root &&
      existing.workerId === input.workerId
    ) {
      const descriptor = await this.#openWorkerShare({
        publicBasePath: existing.publicBasePath,
        root: existing.root,
        shareId: existing.attachment.attachmentId,
        workerId: existing.workerId,
      });
      if (
        descriptor.protocol === existing.attachment.protocol &&
        descriptor.username === existing.attachment.username &&
        descriptor.password === existing.attachment.password &&
        descriptor.realm === existing.attachment.realm
      ) {
        const now = Date.now();
        this.#touch(existing, now);
        return projectShareAttachmentSchema.parse({
          ...existing.attachment,
          expiresAt: new Date(existing.expiresAt).toISOString(),
          mountLeaseMs: Math.max(
            1,
            existing.createdAt + this.#maxLifetimeMs - now,
          ),
        });
      }
    }

    if (existing) await this.#revoke(existing);
    return this.#open(input);
  }

  async #openWorkerShare(input: {
    publicBasePath: string;
    root: string;
    shareId: string;
    workerId: string;
  }) {
    const rawDescriptor = await this.bridge.request(
      input.workerId,
      {
        type: "project.share.open",
        publicBasePath: input.publicBasePath,
        publicOrigin: this.#surfaceOrigin.origin,
        root: input.root,
        shareId: input.shareId,
      },
      { timeoutMs: WORKER_SHARE_COMMAND_TIMEOUT_MS },
    );
    const descriptor = workerProjectShareOpenResultSchema.parse(rawDescriptor);
    if (
      descriptor.shareId !== input.shareId ||
      descriptor.publicBasePath !== input.publicBasePath ||
      descriptor.publicOrigin !== this.#surfaceOrigin.origin
    ) {
      throw new Error("Worker opened an unexpected project share.");
    }
    return descriptor;
  }

  async #open(input: OpenProjectShareInput): Promise<ProjectShareAttachment> {
    if (!this.bridge.isConnected(input.workerId)) {
      throw new Error(`Worker ${input.workerId} is offline.`);
    }
    const token = randomBytes(32).toString("base64url");
    const publicBasePath = `/project-shares/${token}`;
    const shareId = randomUUID();
    let managedTunnelId: string | null = null;
    try {
      const descriptor = await this.#openWorkerShare({
        publicBasePath,
        root: input.root,
        shareId,
        workerId: input.workerId,
      });
      if (!this.bridge.isConnected(input.workerId)) {
        throw new Error(`Worker ${input.workerId} disconnected.`);
      }
      const now = Date.now();
      const expiresAt = now + Math.min(this.#idleTtlMs, this.#maxLifetimeMs);
      const attachment = projectShareAttachmentSchema.parse({
        attachmentId: shareId,
        projectId: input.projectId,
        protocol: descriptor.protocol,
        url: new URL(`${publicBasePath}/`, this.#surfaceOrigin).toString(),
        username: descriptor.username,
        password: descriptor.password,
        realm: descriptor.realm,
        expiresAt: new Date(expiresAt).toISOString(),
        mountLeaseMs: this.#maxLifetimeMs,
      });
      if (this.#repository) {
        const tunnel = await this.#repository.registerManagedTunnel(
          input.ownerId,
          {
            name: "Project files",
            description: "Secure WebDAV access to this project's files.",
            projectId: input.projectId,
            origin: "project-share",
            management: "managed-ephemeral",
            protocolHint: "webdav",
            source: { kind: "server-http", adapter: "project-share" },
            destination: {
              kind: "worker-adapter",
              workerId: input.workerId,
              adapter: "project-share",
              resourceId: shareId,
            },
            managedBy: { kind: "project-share", id: shareId },
            desiredState: "started",
            status: "starting",
          },
        );
        if (!tunnel) {
          throw new Error("Could not register the project share tunnel.");
        }
        managedTunnelId = tunnel.id;
        if (
          !(await this.#repository.createManagedServerRelayAttachment(
            input.ownerId,
            tunnel.id,
            shareId,
            new Date(expiresAt),
          ))
        ) {
          throw new Error("Could not activate the project share tunnel.");
        }
      } else {
        managedTunnelId = `project-share:${shareId}`;
      }
      const destination = new WorkerTunnelEndpoint(
        this.bridge,
        input.workerId,
        `worker:${shareId}`,
      );
      let binding!: ProjectShareAttachmentBinding;
      const source = new ProjectShareHttpEndpoint(
        managedTunnelId,
        shareId,
        destination.endpointId,
        (metrics) => this.#recordMetrics(binding, metrics),
      );
      const route = this.#streamBroker.registerRoute({
        attachmentId: shareId,
        destination,
        destinationTarget: {
          kind: "adapter",
          adapter: "project-share",
          resourceId: shareId,
        },
        source,
        tunnelId: managedTunnelId,
        ownerId: input.ownerId,
        workerId: input.workerId,
      });
      binding = {
        attachment,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        ownerId: input.ownerId,
        publicBasePath,
        root: input.root,
        route,
        source,
        telemetry: this.#repository
          ? new ManagedServerRelayTelemetry(
              this.#repository,
              {
                attachmentId: shareId,
                ownerId: input.ownerId,
                projectId: input.projectId,
                tunnelId: managedTunnelId,
              },
              this.#changed,
            )
          : null,
        token,
        tunnelId: managedTunnelId,
        workerId: input.workerId,
      };
      this.#attachments.set(token, binding);
      this.#attachmentsByProject.set(projectKey(input), binding);
      this.#trackWorkerDisconnect(input.workerId);
      this.#changed?.({
        attachmentId: shareId,
        ownerId: input.ownerId,
        projectId: input.projectId,
        tunnelId: managedTunnelId,
      });
      return attachment;
    } catch (error) {
      if (managedTunnelId && this.#repository) {
        await this.#repository
          .removeManagedTunnel(input.ownerId, {
            kind: "project-share",
            id: shareId,
          })
          .catch(() => undefined);
      }
      const closed = await this.bridge
        .request(
          input.workerId,
          { type: "project.share.close", shareId },
          { timeoutMs: WORKER_SHARE_CLOSE_TIMEOUT_MS },
        )
        .then(() => true)
        .catch(() => false);
      if (!closed) this.#markOrphanedWorkerShare(input.workerId, shareId);
      throw error;
    }
  }

  #resolve(token: string): ProjectShareAttachmentBinding | null {
    const binding = this.#attachments.get(token);
    if (!binding) return null;
    const now = Date.now();
    if (
      binding.expiresAt <= now ||
      binding.createdAt + this.#maxLifetimeMs <= now
    ) {
      void this.#remove(binding);
      void this.#closeWorkerShare(binding);
      return null;
    }
    this.#touch(binding, now);
    return binding;
  }

  #prune(): void {
    const now = Date.now();
    for (const binding of this.#attachments.values()) {
      if (
        binding.expiresAt <= now ||
        binding.createdAt + this.#maxLifetimeMs <= now
      ) {
        void this.#remove(binding);
        void this.#closeWorkerShare(binding);
      }
    }
  }

  #touch(binding: ProjectShareAttachmentBinding, now = Date.now()): void {
    binding.lastSeenAt = now;
    binding.expiresAt = Math.min(
      binding.createdAt + this.#maxLifetimeMs,
      now + this.#idleTtlMs,
    );
    binding.telemetry?.renew(new Date(binding.expiresAt));
  }

  #requestMatchesBinding(
    request: IncomingMessage,
    binding: ProjectShareAttachmentBinding,
  ): boolean {
    const url = new URL(request.url ?? "/", "http://cantrip-share.invalid");
    return (
      url.pathname === binding.publicBasePath ||
      url.pathname.startsWith(`${binding.publicBasePath}/`)
    );
  }

  async #revoke(binding: ProjectShareAttachmentBinding): Promise<void> {
    await Promise.all([this.#remove(binding), this.#closeWorkerShare(binding)]);
  }

  async #remove(binding: ProjectShareAttachmentBinding): Promise<void> {
    this.#attachments.delete(binding.token);
    const key = projectKey({
      ownerId: binding.ownerId,
      projectId: binding.attachment.projectId,
    });
    if (this.#attachmentsByProject.get(key) === binding) {
      this.#attachmentsByProject.delete(key);
    }
    binding.source.close();
    binding.route.close();
    await binding.telemetry?.close(new Date(binding.expiresAt));
    if (this.#repository) {
      await this.#repository
        .removeManagedTunnel(binding.ownerId, {
          kind: "project-share",
          id: binding.attachment.attachmentId,
        })
        .then(() =>
          this.#changed?.({
            attachmentId: binding.attachment.attachmentId,
            ownerId: binding.ownerId,
            projectId: binding.attachment.projectId,
            tunnelId: binding.tunnelId,
          }),
        )
        .catch(() => undefined);
    }
    this.#stopTrackingWorkerIfUnused(binding.workerId);
  }

  #recordMetrics(
    binding: ProjectShareAttachmentBinding,
    input: {
      bytesFromSource: number;
      bytesToSource: number;
      connectionDelta: number;
    },
  ): void {
    if (!binding) return;
    const now = Date.now();
    binding.lastSeenAt = now;
    binding.expiresAt = Math.min(
      binding.createdAt + this.#maxLifetimeMs,
      now + this.#idleTtlMs,
    );
    binding.telemetry?.record(input, new Date(binding.expiresAt));
  }

  async #closeWorkerShare(
    binding: ProjectShareAttachmentBinding,
  ): Promise<void> {
    const closed = await this.bridge
      .request(
        binding.workerId,
        {
          type: "project.share.close",
          shareId: binding.attachment.attachmentId,
        },
        { timeoutMs: WORKER_SHARE_CLOSE_TIMEOUT_MS },
      )
      .then(() => true)
      .catch(() => false);
    if (!closed) {
      this.#markOrphanedWorkerShare(
        binding.workerId,
        binding.attachment.attachmentId,
      );
    }
  }

  #trackWorkerDisconnect(workerId: string): void {
    if (this.#workerDisconnectSubscriptions.has(workerId)) return;
    const unsubscribe = this.bridge.subscribeWorkerDisconnect(workerId, () => {
      for (const binding of [...this.#attachments.values()]) {
        if (binding.workerId !== workerId) continue;
        this.#markOrphanedWorkerShare(
          workerId,
          binding.attachment.attachmentId,
        );
        void this.#remove(binding);
      }
    });
    this.#workerDisconnectSubscriptions.set(workerId, unsubscribe);
  }

  #stopTrackingWorkerIfUnused(workerId: string): void {
    if (
      [...this.#attachments.values()].some(
        (binding) => binding.workerId === workerId,
      )
    ) {
      return;
    }
    this.#workerDisconnectSubscriptions.get(workerId)?.();
    this.#workerDisconnectSubscriptions.delete(workerId);
  }

  #markOrphanedWorkerShare(workerId: string, shareId: string): void {
    let shares = this.#orphanedShareIds.get(workerId);
    if (!shares) {
      shares = new Set();
      this.#orphanedShareIds.set(workerId, shares);
    }
    shares.add(shareId);
  }

  async #flushOrphanedWorkerShares(workerId: string): Promise<void> {
    const shares = this.#orphanedShareIds.get(workerId);
    if (!shares || shares.size === 0 || !this.bridge.isConnected(workerId)) {
      return;
    }
    this.#orphanedShareIds.delete(workerId);
    await Promise.all(
      [...shares].map(async (shareId) => {
        await this.bridge
          .request(
            workerId,
            { type: "project.share.close", shareId },
            { timeoutMs: WORKER_SHARE_CLOSE_TIMEOUT_MS },
          )
          .catch(() => this.#markOrphanedWorkerShare(workerId, shareId));
      }),
    );
  }
}

export function projectShareTokenFromRequest(
  request: IncomingMessage,
): string | null {
  const url = new URL(request.url ?? "/", "http://cantrip-share.invalid");
  return (
    /^\/project-shares\/([A-Za-z0-9_-]{43})(?:\/|$)/u.exec(url.pathname)?.[1] ??
    null
  );
}
