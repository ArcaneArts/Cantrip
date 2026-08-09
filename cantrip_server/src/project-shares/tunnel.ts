import { randomBytes, randomUUID } from "node:crypto";
import { type IncomingMessage, type ServerResponse } from "node:http";

import {
  PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES,
  type ProjectShareAttachment,
  type ProjectShareTunnelFrameHeader,
  projectShareAttachmentSchema,
  projectSharePublicOriginSchema,
  workerProjectShareOpenResultSchema,
} from "@cantrip/protocol";

import type { WorkerCommandBus } from "../workers/bridge.js";

export interface ProjectShareAttachmentBinding {
  attachment: ProjectShareAttachment;
  createdAt: number;
  expiresAt: number;
  lastSeenAt: number;
  ownerId: string;
  publicBasePath: string;
  root: string;
  token: string;
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

const EMPTY_PAYLOAD = new Uint8Array();
const MAX_BUFFERED_BYTES = 8 * 1_024 * 1_024;
const MAX_ACTIVE_STREAMS_PER_ATTACHMENT = 64;
const RESPONSE_START_TIMEOUT_MS = 30_000;
const WORKER_SHARE_COMMAND_TIMEOUT_MS = 30_000;
const WORKER_SHARE_CLOSE_TIMEOUT_MS = 5_000;
const MAX_NATIVE_MOUNT_LEASE_MS = 24 * 60 * 60_000;
const BLOCKED_CLIENT_HEADERS = new Set([
  "connection",
  "cookie",
  "host",
  "proxy-authorization",
  "proxy-connection",
  "transfer-encoding",
  "upgrade",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-port",
  "x-forwarded-prefix",
  "x-forwarded-proto",
]);
const BLOCKED_WORKER_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "set-cookie",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function projectKey(input: { ownerId: string; projectId: string }): string {
  return `${input.ownerId}\0${input.projectId}`;
}

function streamMatches(
  header: ProjectShareTunnelFrameHeader,
  binding: ProjectShareAttachmentBinding,
  streamId: string,
): boolean {
  return (
    header.shareId === binding.attachment.attachmentId &&
    header.streamId === streamId
  );
}

function splitPayload(payload: Uint8Array): Uint8Array[] {
  const parts: Uint8Array[] = [];
  for (
    let offset = 0;
    offset < payload.byteLength;
    offset += PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES
  ) {
    parts.push(
      payload.subarray(offset, offset + PROJECT_SHARE_TUNNEL_MAX_PAYLOAD_BYTES),
    );
  }
  return parts.length > 0 ? parts : [EMPTY_PAYLOAD];
}

export class ProjectShareTunnelBroker {
  readonly #activeStreams = new Map<string, Set<() => void>>();
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
    const sendFrame = this.bridge.sendProjectShareTunnelFrame;
    const subscribe = this.bridge.subscribeProjectShareTunnelFrames;
    if (
      !sendFrame ||
      !subscribe ||
      !this.bridge.isConnected(binding.workerId)
    ) {
      response
        .writeHead(503, { "cache-control": "no-store" })
        .end("Worker offline");
      return;
    }
    if (
      (this.#activeStreams.get(binding.attachment.attachmentId)?.size ?? 0) >=
      MAX_ACTIVE_STREAMS_PER_ATTACHMENT
    ) {
      response
        .writeHead(429, { "cache-control": "no-store" })
        .end("Project share is busy");
      return;
    }
    const streamId = randomUUID();
    let started = false;
    let completed = false;
    let workerPaused = false;
    let unregisterActive: () => void = () => undefined;
    const sendResponseFlow = (
      kind: "http-response-pause" | "http-response-resume",
    ) =>
      sendFrame.call(
        this.bridge,
        binding.workerId,
        {
          protocolVersion: 1,
          shareId: binding.attachment.attachmentId,
          streamId,
          kind,
        },
        EMPTY_PAYLOAD,
      );
    const resumeWorker = () => {
      if (completed || !workerPaused) return;
      workerPaused = false;
      if (!sendResponseFlow("http-response-resume")) {
        this.#sendCancel(binding, streamId, "Client response resume failed.");
        fail(503, "Project share worker is unavailable or congested.");
      }
    };
    const finish = () => {
      if (completed) return;
      completed = true;
      clearTimeout(startTimer);
      response.off("drain", resumeWorker);
      unsubscribe();
      unsubscribeDisconnect();
      unregisterActive();
    };
    const fail = (status: number, message: string) => {
      if (completed) return;
      if (!response.headersSent) {
        response.writeHead(status, {
          "cache-control": "no-store",
          "content-type": "text/plain; charset=utf-8",
        });
        response.end(message);
      } else {
        response.destroy(new Error(message));
      }
      finish();
    };
    const unsubscribe = subscribe.call(
      this.bridge,
      binding.workerId,
      (header, payload) => {
        if (completed || !streamMatches(header, binding, streamId)) return;
        this.#touch(binding);
        switch (header.kind) {
          case "http-response-start":
            if (started) return;
            started = true;
            clearTimeout(startTimer);
            this.#writeResponseHeaders(
              response,
              header.statusCode,
              header.headers,
            );
            return;
          case "http-response-data":
            if (!started || response.destroyed) return;
            if (
              response.writableLength + payload.byteLength >
              MAX_BUFFERED_BYTES
            ) {
              this.#sendCancel(
                binding,
                streamId,
                "Client response buffer exceeded.",
              );
              fail(502, "Project share client is too slow.");
              return;
            }
            if (!response.write(payload) && !workerPaused) {
              workerPaused = true;
              if (!sendResponseFlow("http-response-pause")) {
                this.#sendCancel(
                  binding,
                  streamId,
                  "Client response pause failed.",
                );
                fail(503, "Project share worker is unavailable or congested.");
              }
            }
            return;
          case "http-response-end":
            if (!started) this.#writeResponseHeaders(response, 200, []);
            response.end();
            finish();
            return;
          case "error":
            fail(502, header.message);
            return;
          default:
            return;
        }
      },
    );
    const unsubscribeDisconnect = this.bridge.subscribeWorkerDisconnect(
      binding.workerId,
      () => fail(503, "Project share worker disconnected."),
    );
    const startTimer = setTimeout(() => {
      this.#sendCancel(binding, streamId, "WebDAV response timed out.");
      fail(504, "Project share response timed out.");
    }, RESPONSE_START_TIMEOUT_MS);
    unregisterActive = this.#registerActive(binding, () => {
      this.#sendCancel(binding, streamId, "Project share was revoked.");
      fail(401, "Project share expired or was revoked.");
    });
    response.on("drain", resumeWorker);

    const requestHeader: ProjectShareTunnelFrameHeader = {
      protocolVersion: 1,
      shareId: binding.attachment.attachmentId,
      streamId,
      kind: "http-request-start",
      method: (request.method ?? "GET").toUpperCase(),
      path: request.url ?? `${binding.publicBasePath}/`,
      headers: this.#requestHeaders(request),
    };
    if (
      !sendFrame.call(
        this.bridge,
        binding.workerId,
        requestHeader,
        EMPTY_PAYLOAD,
      )
    ) {
      fail(503, "Project share worker is unavailable or congested.");
      return;
    }
    request.on("data", (chunk: Buffer) => {
      if (completed) return;
      this.#touch(binding);
      for (const part of splitPayload(chunk)) {
        if (
          !sendFrame.call(
            this.bridge,
            binding.workerId,
            { ...requestHeader, kind: "http-request-data" },
            part,
          )
        ) {
          this.#sendCancel(
            binding,
            streamId,
            "Worker request buffer exceeded.",
          );
          fail(503, "Project share worker is unavailable or congested.");
          return;
        }
      }
    });
    request.once("end", () => {
      if (completed) return;
      if (
        !sendFrame.call(
          this.bridge,
          binding.workerId,
          { ...requestHeader, kind: "http-request-end" },
          EMPTY_PAYLOAD,
        )
      ) {
        fail(503, "Project share worker is unavailable or congested.");
      }
    });
    request.once("aborted", () => {
      this.#sendCancel(binding, streamId, "Client aborted request.");
      finish();
    });
    response.once("close", () => {
      if (completed) return;
      this.#sendCancel(binding, streamId, "Client closed response.");
      finish();
    });
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
      const binding: ProjectShareAttachmentBinding = {
        attachment,
        createdAt: now,
        expiresAt,
        lastSeenAt: now,
        ownerId: input.ownerId,
        publicBasePath,
        root: input.root,
        token,
        workerId: input.workerId,
      };
      this.#attachments.set(token, binding);
      this.#attachmentsByProject.set(projectKey(input), binding);
      this.#trackWorkerDisconnect(input.workerId);
      return attachment;
    } catch (error) {
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
      this.#remove(binding);
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
        this.#remove(binding);
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

  #requestHeaders(request: IncomingMessage): Array<[string, string]> {
    const headers: Array<[string, string]> = [];
    for (let index = 0; index < request.rawHeaders.length; index += 2) {
      const name = request.rawHeaders[index];
      const value = request.rawHeaders[index + 1];
      if (
        !name ||
        value === undefined ||
        BLOCKED_CLIENT_HEADERS.has(name.toLowerCase())
      ) {
        continue;
      }
      headers.push([name, value]);
    }
    return headers;
  }

  #writeResponseHeaders(
    response: ServerResponse,
    statusCode: number,
    headers: Array<[string, string]>,
  ): void {
    const values = new Map<string, { name: string; values: string[] }>();
    for (const [name, value] of headers) {
      const lower = name.toLowerCase();
      if (BLOCKED_WORKER_HEADERS.has(lower)) continue;
      const current = values.get(lower) ?? { name, values: [] };
      current.values.push(value);
      values.set(lower, current);
    }
    for (const { name, values: headerValues } of values.values()) {
      response.setHeader(
        name,
        headerValues.length === 1 ? headerValues[0]! : headerValues,
      );
    }
    response.writeHead(statusCode);
  }

  #registerActive(
    binding: ProjectShareAttachmentBinding,
    close: () => void,
  ): () => void {
    const attachmentId = binding.attachment.attachmentId;
    let streams = this.#activeStreams.get(attachmentId);
    if (!streams) {
      streams = new Set();
      this.#activeStreams.set(attachmentId, streams);
    }
    streams.add(close);
    return () => {
      streams?.delete(close);
      if (streams?.size === 0) this.#activeStreams.delete(attachmentId);
    };
  }

  async #revoke(binding: ProjectShareAttachmentBinding): Promise<void> {
    this.#remove(binding);
    await this.#closeWorkerShare(binding);
  }

  #remove(binding: ProjectShareAttachmentBinding): void {
    this.#attachments.delete(binding.token);
    const key = projectKey({
      ownerId: binding.ownerId,
      projectId: binding.attachment.projectId,
    });
    if (this.#attachmentsByProject.get(key) === binding) {
      this.#attachmentsByProject.delete(key);
    }
    const attachmentId = binding.attachment.attachmentId;
    const streams = this.#activeStreams.get(attachmentId);
    this.#activeStreams.delete(attachmentId);
    for (const close of [...(streams ?? [])]) close();
    this.#stopTrackingWorkerIfUnused(binding.workerId);
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
        this.#remove(binding);
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

  #sendCancel(
    binding: ProjectShareAttachmentBinding,
    streamId: string,
    reason: string,
  ): void {
    this.bridge.sendProjectShareTunnelFrame?.(
      binding.workerId,
      {
        protocolVersion: 1,
        shareId: binding.attachment.attachmentId,
        streamId,
        kind: "cancel",
        reason: reason.slice(0, 1_024),
      },
      EMPTY_PAYLOAD,
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
