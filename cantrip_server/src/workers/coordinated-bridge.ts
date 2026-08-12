import { randomUUID } from "node:crypto";

import {
  remoteSurfaceFrameHeaderSchema,
  tunnelDataPlaneFrameHeaderSchema,
  workerCommandSchema,
  workerEventSchema,
  workerNotificationSchema,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
} from "@cantrip/protocol";

import type {
  RelayCoordinationMessage,
  RelayCoordinator,
  WorkerPresenceClaim,
} from "../coordination/relay-coordinator.js";
import type {
  WorkerCommandBus,
  WorkerCommandBusStats,
  WorkerNotificationListener,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
} from "./bridge.js";
import { WorkerBridge, WorkerUnavailableError } from "./bridge.js";

const MAX_PENDING_REMOTE_REQUESTS = 2_048;
const MAX_INCOMING_REMOTE_REQUESTS = 512;
const MAX_OUTBOUND_PUBLICATIONS = 512;
const MAX_REMOTE_COMMAND_LIFETIME_MS = 24 * 60 * 60_000;

type WorkerSocket = Parameters<WorkerCommandBus["attach"]>[1];
type Transport = "surface" | "tunnel";

interface LocalConnection {
  connectionId: string;
  ownerId: string;
  unsubscribers: Array<() => void>;
}

interface PendingRemoteRequest {
  eventQueue: Promise<void>;
  onEvent?: WorkerRequestOptions["onEvent"];
  reject(error: Error): void;
  resolve(value: unknown): void;
  timeout: ReturnType<typeof setTimeout>;
  workerId: string;
}

export interface CoordinatedWorkerBridgeOptions {
  coordinator: RelayCoordinator;
  resolveOwnerId(workerId: string): Promise<string | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function decodePayload(value: string): Uint8Array | null {
  if (value.length > 16 * 1_024 * 1_024) return null;
  try {
    return new Uint8Array(Buffer.from(value, "base64"));
  } catch {
    return null;
  }
}

export class CoordinatedWorkerBridge implements WorkerCommandBus {
  readonly #connections = new Map<string, LocalConnection>();
  readonly #coordinator: RelayCoordinator;
  readonly #disconnectListeners = new Map<string, Set<() => void>>();
  readonly #local = new WorkerBridge();
  readonly #knownRemoteWorkers = new Set<string>();
  readonly #notificationListeners = new Map<
    string,
    Set<WorkerNotificationListener>
  >();
  readonly #pending = new Map<string, PendingRemoteRequest>();
  readonly #resolveOwnerId: CoordinatedWorkerBridgeOptions["resolveOwnerId"];
  readonly #surfaceListeners = new Map<
    string,
    Set<WorkerSurfaceFrameListener>
  >();
  readonly #tunnelListeners = new Map<
    string,
    Set<WorkerTunnelDataPlaneFrameListener>
  >();
  readonly #unsubscribeCoordination: () => void;
  readonly #presenceTimer: ReturnType<typeof setInterval>;
  #closed = false;
  #failedRequests = 0;
  #incomingRequests = 0;
  #outboundPublications = 0;
  #routedRequests = 0;
  #succeededRequests = 0;

  constructor(options: CoordinatedWorkerBridgeOptions) {
    this.#coordinator = options.coordinator;
    this.#resolveOwnerId = options.resolveOwnerId;
    this.#unsubscribeCoordination = this.#coordinator.subscribe((message) =>
      this.#receive(message),
    );
    this.#presenceTimer = setInterval(
      () => void this.#refreshPresence(),
      Math.max(1_000, Math.floor(this.#coordinator.presenceTtlMs / 3)),
    );
    this.#presenceTimer.unref();
  }

  async attach(
    workerId: string,
    socket: WorkerSocket,
    ownerId?: string,
  ): Promise<void> {
    if (this.#closed) {
      socket.close(1012, "Server is shutting down");
      return;
    }
    const resolvedOwnerId = ownerId ?? (await this.#resolveOwnerId(workerId));
    if (!resolvedOwnerId) {
      socket.close(1008, "Worker owner is unavailable");
      return;
    }
    this.#local.disconnect(workerId, "Worker reconnected", 1012);
    const connectionId = randomUUID();
    const previous = await this.#coordinator.claimWorker({
      connectionId,
      ownerId: resolvedOwnerId,
      workerId,
    });
    if (
      previous &&
      (previous.instanceId !== this.#coordinator.instanceId ||
        previous.connectionId !== connectionId)
    ) {
      await this.#coordinator.publish({
        kind: "worker-disconnect",
        targetInstanceId: previous.instanceId,
        workerId,
        connectionId: previous.connectionId,
        code: 1012,
        reason: "Worker connected to another server instance",
      });
    }

    this.#local.attach(workerId, socket);
    const unsubscribers = [
      this.#local.subscribeWorkerDisconnect(workerId, () => {
        void this.#localDisconnected(workerId, connectionId);
      }),
      this.#local.subscribeSurfaceFrames(workerId, (header, payload) => {
        this.#dispatchFrame("surface", workerId, header, payload);
        this.#publishWorkerFrame(
          "from-worker",
          "surface",
          resolvedOwnerId,
          workerId,
          header,
          payload,
        );
      }),
      this.#local.subscribeTunnelDataPlaneFrames(
        workerId,
        (header, payload) => {
          this.#dispatchFrame("tunnel", workerId, header, payload);
          this.#publishWorkerFrame(
            "from-worker",
            "tunnel",
            resolvedOwnerId,
            workerId,
            header,
            payload,
          );
        },
      ),
      this.#local.subscribeNotifications(workerId, (notification) => {
        this.#dispatchNotification(workerId, notification);
        this.#publishBounded({
          kind: "worker-notification",
          ownerId: resolvedOwnerId,
          workerId,
          notification,
        });
      }),
    ];
    this.#connections.set(workerId, {
      connectionId,
      ownerId: resolvedOwnerId,
      unsubscribers,
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    clearInterval(this.#presenceTimer);
    this.#unsubscribeCoordination();
    const releases: Array<Promise<boolean>> = [];
    for (const [workerId, connection] of this.#connections) {
      for (const unsubscribe of connection.unsubscribers) unsubscribe();
      releases.push(
        this.#coordinator.releaseWorker(workerId, connection.connectionId),
      );
    }
    this.#connections.clear();
    this.#local.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new WorkerUnavailableError("Server is shutting down."));
    }
    this.#pending.clear();
    this.#disconnectListeners.clear();
    this.#notificationListeners.clear();
    this.#surfaceListeners.clear();
    this.#tunnelListeners.clear();
    this.#knownRemoteWorkers.clear();
    await Promise.allSettled(releases);
  }

  disconnect(workerId: string, reason?: string, code?: number): void {
    const local = this.#connections.get(workerId);
    if (local) {
      this.#local.disconnect(workerId, reason, code);
      return;
    }
    const presence = this.#coordinator.cachedWorker(workerId);
    if (!presence) {
      void this.#coordinator
        .findWorker(workerId)
        .then((remote) => {
          if (!remote) return;
          this.#knownRemoteWorkers.add(workerId);
          this.#publishBounded({
            kind: "worker-disconnect",
            targetInstanceId: remote.instanceId,
            workerId,
            connectionId: remote.connectionId,
            code: code ?? 1008,
            reason: reason ?? "Worker credential was revoked",
          });
        })
        .catch(() => undefined);
      return;
    }
    this.#knownRemoteWorkers.add(workerId);
    this.#publishBounded({
      kind: "worker-disconnect",
      targetInstanceId: presence.instanceId,
      workerId,
      connectionId: presence.connectionId,
      code: code ?? 1008,
      reason: reason ?? "Worker credential was revoked",
    });
  }

  isConnected(workerId: string): boolean {
    if (this.#local.isConnected(workerId)) return true;
    const connected = this.#coordinator.cachedWorker(workerId) !== null;
    if (connected) this.#knownRemoteWorkers.add(workerId);
    return connected;
  }

  stats(): WorkerCommandBusStats {
    return {
      activeRequests: this.#pending.size + this.#local.stats().activeRequests,
      connectedWorkers: this.#coordinator.stats().cachedWorkers,
      failedRequests: this.#failedRequests,
      routedRequests: this.#routedRequests,
      succeededRequests: this.#succeededRequests,
    };
  }

  request(
    workerId: string,
    command: WorkerCommand,
    options: WorkerRequestOptions = {},
  ): Promise<unknown> {
    if (this.#local.isConnected(workerId)) {
      return this.#local.request(workerId, command, options);
    }
    return this.#requestRemote(workerId, command, options);
  }

  sendSurfaceFrame(
    workerId: string,
    header: RemoteSurfaceFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return this.#sendFrame("surface", workerId, header, payload);
  }

  sendTunnelDataPlaneFrame(
    workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    return this.#sendFrame("tunnel", workerId, header, payload);
  }

  subscribeWorkerDisconnect(
    workerId: string,
    listener: () => void,
  ): () => void {
    return this.#subscribe(this.#disconnectListeners, workerId, listener);
  }

  subscribeSurfaceFrames(
    workerId: string,
    listener: WorkerSurfaceFrameListener,
  ): () => void {
    return this.#subscribe(this.#surfaceListeners, workerId, listener);
  }

  subscribeTunnelDataPlaneFrames(
    workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ): () => void {
    return this.#subscribe(this.#tunnelListeners, workerId, listener);
  }

  subscribeNotifications(
    workerId: string,
    listener: WorkerNotificationListener,
  ): () => void {
    return this.#subscribe(this.#notificationListeners, workerId, listener);
  }

  async #requestRemote(
    workerId: string,
    command: WorkerCommand,
    options: WorkerRequestOptions,
  ): Promise<unknown> {
    if (this.#pending.size >= MAX_PENDING_REMOTE_REQUESTS) {
      this.#failedRequests += 1;
      throw new Error("The shared worker command queue is full.");
    }
    const presence = await this.#coordinator.findWorker(workerId);
    if (!presence) {
      this.#failedRequests += 1;
      throw new WorkerUnavailableError(`Worker ${workerId} is offline.`);
    }
    this.#knownRemoteWorkers.add(workerId);
    const ownerId = options.ownerId ?? (await this.#resolveOwnerId(workerId));
    if (!ownerId || ownerId !== presence.ownerId) {
      this.#failedRequests += 1;
      throw new WorkerUnavailableError(`Worker ${workerId} is unavailable.`);
    }
    const timeoutMs = Math.min(
      options.timeoutMs === null
        ? MAX_REMOTE_COMMAND_LIFETIME_MS
        : (options.timeoutMs ?? 10 * 60_000),
      MAX_REMOTE_COMMAND_LIFETIME_MS,
    );
    const requestId = randomUUID();
    this.#routedRequests += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#failedRequests += 1;
        reject(new Error(`Worker command ${command.type} timed out.`));
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(requestId, {
        eventQueue: Promise.resolve(),
        onEvent: options.onEvent,
        reject,
        resolve,
        timeout,
        workerId,
      });
      void this.#coordinator
        .publish(
          {
            kind: "worker-command-request",
            targetInstanceId: presence.instanceId,
            workerId,
            ownerId,
            requestId,
            command,
            timeoutMs,
          },
          timeoutMs,
        )
        .catch((error) => {
          const pending = this.#pending.get(requestId);
          if (!pending) return;
          clearTimeout(pending.timeout);
          this.#pending.delete(requestId);
          this.#failedRequests += 1;
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  async #receive(message: RelayCoordinationMessage): Promise<void> {
    switch (message.kind) {
      case "worker-command-request":
        await this.#receiveCommand(message);
        return;
      case "worker-command-event": {
        const pending = this.#pending.get(message.requestId);
        if (!pending?.onEvent) return;
        const event = workerEventSchema.safeParse(message.event);
        if (!event.success) return;
        pending.eventQueue = pending.eventQueue.then(() =>
          pending.onEvent?.(event.data),
        );
        return;
      }
      case "worker-command-response": {
        const pending = this.#pending.get(message.requestId);
        if (!pending) return;
        clearTimeout(pending.timeout);
        this.#pending.delete(message.requestId);
        try {
          await pending.eventQueue;
        } catch (error) {
          this.#failedRequests += 1;
          pending.reject(
            error instanceof Error ? error : new Error(String(error)),
          );
          return;
        }
        if (message.ok) {
          this.#succeededRequests += 1;
          pending.resolve(message.result);
        } else {
          this.#failedRequests += 1;
          pending.reject(
            new Error(message.error ?? "Remote worker command failed."),
          );
        }
        return;
      }
      case "worker-disconnect": {
        const local = this.#connections.get(message.workerId);
        if (local?.connectionId === message.connectionId) {
          this.#local.disconnect(
            message.workerId,
            message.reason,
            message.code,
          );
        }
        return;
      }
      case "worker-frame":
        await this.#receiveFrame(message);
        return;
      case "worker-notification": {
        const presence = this.#coordinator.cachedWorker(message.workerId);
        if (presence?.ownerId !== message.ownerId) return;
        const notification = workerNotificationSchema.safeParse(
          message.notification,
        );
        if (notification.success) {
          this.#dispatchNotification(message.workerId, notification.data);
        }
        return;
      }
      case "worker-presence":
        if (message.action === "online") {
          if (!this.#connections.has(message.presence.workerId)) {
            this.#knownRemoteWorkers.add(message.presence.workerId);
          }
        } else {
          this.#knownRemoteWorkers.delete(message.presence.workerId);
          this.#dispatchDisconnect(message.presence.workerId);
        }
        return;
      case "live-publication":
        return;
    }
  }

  async #receiveCommand(
    message: Extract<
      RelayCoordinationMessage,
      { kind: "worker-command-request" }
    >,
  ): Promise<void> {
    if (this.#incomingRequests >= MAX_INCOMING_REMOTE_REQUESTS) {
      await this.#respond(
        message,
        false,
        undefined,
        "Worker command relay is busy.",
      );
      return;
    }
    const command = workerCommandSchema.safeParse(message.command);
    const local = this.#connections.get(message.workerId);
    const ownerId = await this.#resolveOwnerId(message.workerId);
    if (
      !command.success ||
      !local ||
      !this.#local.isConnected(message.workerId) ||
      local.ownerId !== message.ownerId ||
      ownerId !== message.ownerId
    ) {
      await this.#respond(message, false, undefined, "Worker is unavailable.");
      return;
    }
    this.#incomingRequests += 1;
    try {
      const result = await this.#local.request(message.workerId, command.data, {
        ownerId: message.ownerId,
        timeoutMs: Math.min(message.timeoutMs, MAX_REMOTE_COMMAND_LIFETIME_MS),
        onEvent: async (event) => {
          await this.#coordinator.publish(
            {
              kind: "worker-command-event",
              targetInstanceId: message.sourceInstanceId,
              requestId: message.requestId,
              event,
            },
            message.timeoutMs,
          );
        },
      });
      await this.#respond(message, true, result);
    } catch (error) {
      await this.#respond(message, false, undefined, errorMessage(error));
    } finally {
      this.#incomingRequests -= 1;
    }
  }

  async #respond(
    request: Extract<
      RelayCoordinationMessage,
      { kind: "worker-command-request" }
    >,
    ok: boolean,
    result?: unknown,
    error?: string,
  ): Promise<void> {
    await this.#coordinator.publish(
      {
        kind: "worker-command-response",
        targetInstanceId: request.sourceInstanceId,
        requestId: request.requestId,
        ok,
        result,
        error,
      },
      request.timeoutMs,
    );
  }

  async #receiveFrame(
    message: Extract<RelayCoordinationMessage, { kind: "worker-frame" }>,
  ): Promise<void> {
    const presence = this.#coordinator.cachedWorker(message.workerId);
    if (presence?.ownerId !== message.ownerId) return;
    const payload = decodePayload(message.payloadBase64);
    if (!payload) return;
    if (message.direction === "from-worker") {
      this.#dispatchFrame(
        message.transport,
        message.workerId,
        message.header,
        payload,
      );
      return;
    }
    const local = this.#connections.get(message.workerId);
    if (!local || local.ownerId !== message.ownerId) return;
    switch (message.transport) {
      case "surface": {
        const header = remoteSurfaceFrameHeaderSchema.safeParse(message.header);
        if (header.success) {
          this.#local.sendSurfaceFrame(message.workerId, header.data, payload);
        }
        return;
      }
      case "tunnel": {
        const header = tunnelDataPlaneFrameHeaderSchema.safeParse(
          message.header,
        );
        if (header.success) {
          this.#local.sendTunnelDataPlaneFrame(
            message.workerId,
            header.data,
            payload,
          );
        }
      }
    }
  }

  #sendFrame(
    transport: Transport,
    workerId: string,
    header: unknown,
    payload: Uint8Array,
  ): boolean {
    if (this.#local.isConnected(workerId)) {
      if (transport === "surface") {
        return this.#local.sendSurfaceFrame(
          workerId,
          header as RemoteSurfaceFrameHeader,
          payload,
        );
      }
      return this.#local.sendTunnelDataPlaneFrame(
        workerId,
        header as TunnelDataPlaneFrameHeader,
        payload,
      );
    }
    const presence = this.#coordinator.cachedWorker(workerId);
    if (!presence) return false;
    this.#knownRemoteWorkers.add(workerId);
    return this.#publishWorkerFrame(
      "to-worker",
      transport,
      presence.ownerId,
      workerId,
      header,
      payload,
      presence,
    );
  }

  #publishWorkerFrame(
    direction: "to-worker" | "from-worker",
    transport: Transport,
    ownerId: string,
    workerId: string,
    header: unknown,
    payload: Uint8Array,
    presence?: WorkerPresenceClaim,
  ): boolean {
    return this.#publishBounded({
      kind: "worker-frame",
      targetInstanceId:
        direction === "to-worker" ? presence?.instanceId : undefined,
      direction,
      transport,
      ownerId,
      workerId,
      header,
      payloadBase64: Buffer.from(payload).toString("base64"),
    });
  }

  #publishBounded(
    payload: Parameters<RelayCoordinator["publish"]>[0],
  ): boolean {
    if (this.#outboundPublications >= MAX_OUTBOUND_PUBLICATIONS) return false;
    this.#outboundPublications += 1;
    void this.#coordinator
      .publish(payload)
      .catch(() => undefined)
      .finally(() => {
        this.#outboundPublications -= 1;
      });
    return true;
  }

  #dispatchFrame(
    transport: Transport,
    workerId: string,
    header: unknown,
    payload: Uint8Array,
  ): void {
    if (transport === "surface") {
      const parsed = remoteSurfaceFrameHeaderSchema.safeParse(header);
      if (!parsed.success) return;
      for (const listener of this.#surfaceListeners.get(workerId) ?? []) {
        listener(parsed.data, payload);
      }
      return;
    }
    const parsed = tunnelDataPlaneFrameHeaderSchema.safeParse(header);
    if (!parsed.success) return;
    for (const listener of this.#tunnelListeners.get(workerId) ?? []) {
      listener(parsed.data, payload);
    }
  }

  #dispatchNotification(
    workerId: string,
    notification: WorkerNotification,
  ): void {
    for (const listener of this.#notificationListeners.get(workerId) ?? []) {
      void Promise.resolve(listener(notification)).catch(() => undefined);
    }
  }

  #dispatchDisconnect(workerId: string): void {
    for (const listener of this.#disconnectListeners.get(workerId) ?? []) {
      listener();
    }
  }

  async #localDisconnected(
    workerId: string,
    connectionId: string,
  ): Promise<void> {
    const connection = this.#connections.get(workerId);
    if (!connection || connection.connectionId !== connectionId) return;
    this.#connections.delete(workerId);
    for (const unsubscribe of connection.unsubscribers) unsubscribe();
    const released = await this.#coordinator.releaseWorker(
      workerId,
      connectionId,
    );
    if (released) this.#dispatchDisconnect(workerId);
  }

  async #refreshPresence(): Promise<void> {
    for (const [workerId, connection] of [...this.#connections]) {
      let retained: boolean;
      try {
        retained = await this.#coordinator.refreshWorker(
          workerId,
          connection.connectionId,
        );
      } catch {
        // Readiness reports the shared dependency outage. Keep the socket until
        // Redis can confirm that this fenced claim was actually lost.
        continue;
      }
      if (!retained) {
        this.#local.disconnect(
          workerId,
          "Worker connection was claimed by another server instance",
          1012,
        );
      }
    }
    const observedWorkers = new Set([
      ...this.#knownRemoteWorkers,
      ...this.#surfaceListeners.keys(),
      ...this.#tunnelListeners.keys(),
      ...this.#notificationListeners.keys(),
      ...this.#disconnectListeners.keys(),
    ]);
    for (const workerId of observedWorkers) {
      if (this.#connections.has(workerId)) continue;
      let presence: WorkerPresenceClaim | null;
      try {
        presence = await this.#coordinator.findWorker(workerId);
      } catch {
        continue;
      }
      if (presence) {
        this.#knownRemoteWorkers.add(workerId);
      } else if (this.#knownRemoteWorkers.delete(workerId)) {
        this.#dispatchDisconnect(workerId);
      }
    }
  }

  #subscribe<T>(
    map: Map<string, Set<T>>,
    workerId: string,
    listener: T,
  ): () => void {
    let listeners = map.get(workerId);
    if (!listeners) {
      listeners = new Set();
      map.set(workerId, listeners);
    }
    listeners.add(listener);
    return () => {
      listeners?.delete(listener);
      if (listeners?.size === 0) map.delete(workerId);
    };
  }
}
