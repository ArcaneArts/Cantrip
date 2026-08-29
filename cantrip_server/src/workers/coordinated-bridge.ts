import { randomUUID } from "node:crypto";

import {
  createWorkerLinkFrame,
  remoteSurfaceFrameHeaderSchema,
  tunnelDataPlaneFrameHeaderSchema,
  workerLinkFrameHeaderSchema,
  workerCommandSchema,
  workerEventSchema,
  workerNotificationSchema,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
  type WorkerEvent,
  type WorkerNotification,
  type ValidatedWorkerLinkFrame,
} from "@cantrip/protocol";

import type {
  RelayCoordinationMessage,
  RelayCoordinator,
  WorkerPresenceClaim,
} from "../coordination/relay-coordinator.js";
import { serverLogger } from "../logger.js";
import type {
  WorkerCommandBus,
  WorkerCommandBusStats,
  WorkerConnectionContinuityIdentity,
  WorkerNotificationListener,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
  WorkerLinkFrameListener,
} from "./bridge.js";
import {
  sameWorkerConnectionContinuityIdentity,
  WorkerBridge,
  WorkerCommandError,
  workerSocketIsAttachable,
  WorkerUnavailableError,
} from "./bridge.js";

const MAX_PENDING_REMOTE_REQUESTS = 2_048;
const MAX_INCOMING_REMOTE_REQUESTS = 512;
const MAX_OUTBOUND_PUBLICATIONS = 512;
const MAX_REMOTE_COMMAND_LIFETIME_MS = 24 * 60 * 60_000;

type WorkerSocket = Parameters<WorkerCommandBus["attach"]>[1];
type Transport = "surface" | "tunnel" | "worker-link";

interface LocalConnection {
  connectionId: string;
  continuityIdentity?: WorkerConnectionContinuityIdentity;
  ownerId: string;
  unsubscribers: Array<() => void>;
}

interface PendingRemoteRequest {
  commandType: WorkerCommand["type"];
  eventQueue: Promise<void>;
  onEvent?: WorkerRequestOptions["onEvent"];
  reject(error: Error): void;
  resolve(value: unknown): void;
  startedAtMs: number;
  timeout: ReturnType<typeof setTimeout>;
  workerId: string;
}

export interface CoordinatedWorkerBridgeOptions {
  coordinator: RelayCoordinator;
  reconnectGraceMs?: number;
  resolveOwnerId(workerId: string): Promise<string | null>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stableWorkerFailureCode(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= 100 &&
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(value)
    ? value
    : null;
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
  readonly #attachmentGenerations = new Map<string, symbol>();
  readonly #connections = new Map<string, LocalConnection>();
  readonly #coordinator: RelayCoordinator;
  readonly #disconnectListeners = new Map<string, Set<() => void>>();
  readonly #local: WorkerBridge;
  readonly #knownRemoteWorkers = new Map<string, string>();
  readonly #offlineListeners = new Map<string, Set<() => void>>();
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
  readonly #workerLinkListeners = new Map<
    string,
    Set<WorkerLinkFrameListener>
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
    this.#local = new WorkerBridge(options.reconnectGraceMs);
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
    continuityIdentity?: WorkerConnectionContinuityIdentity,
  ): Promise<boolean> {
    if (this.#closed) {
      socket.close(1012, "Server is shutting down");
      return false;
    }
    if (!workerSocketIsAttachable(socket)) return false;
    const attachmentGeneration = Symbol(workerId);
    this.#attachmentGenerations.set(workerId, attachmentGeneration);
    const resolvedOwnerId = ownerId ?? (await this.#resolveOwnerId(workerId));
    if (
      !this.#isCurrentAttachment(workerId, attachmentGeneration) ||
      !workerSocketIsAttachable(socket)
    ) {
      socket.close(1012, "Worker connection was superseded");
      return false;
    }
    if (!resolvedOwnerId) {
      serverLogger.event("warn", "Worker relay attachment rejected", {
        event: "coordination.worker.attach-rejected",
        subsystem: "relay-coordination",
        operation: "attach-worker",
        reasonCode: "owner-unavailable",
        status: "rejected",
        workerId,
      });
      socket.close(1008, "Worker owner is unavailable");
      return false;
    }
    if (continuityIdentity && continuityIdentity.ownerId !== resolvedOwnerId) {
      socket.close(1008, "Worker continuity identity does not match owner");
      return false;
    }
    const existing = this.#connections.get(workerId);
    const continuityMatches = Boolean(
      existing?.ownerId === resolvedOwnerId &&
      sameWorkerConnectionContinuityIdentity(
        existing.continuityIdentity,
        continuityIdentity,
      ),
    );
    if (existing && continuityMatches) {
      const retained = await this.#coordinator.refreshWorker(
        workerId,
        existing.connectionId,
      );
      if (
        !this.#isCurrentAttachment(workerId, attachmentGeneration) ||
        this.#connections.get(workerId) !== existing ||
        !workerSocketIsAttachable(socket)
      ) {
        socket.close(1012, "Worker connection was superseded");
        return false;
      }
      if (retained) {
        const accepted = this.#local.attach(
          workerId,
          socket,
          resolvedOwnerId,
          continuityIdentity,
        );
        if (!accepted) return false;
        serverLogger.event("info", "Worker relay attachment recovered", {
          event: "coordination.worker.recovered",
          subsystem: "relay-coordination",
          operation: "attach-worker",
          status: "online",
          workerId,
        });
        return true;
      }
    }
    if (!workerSocketIsAttachable(socket)) return false;
    if (existing) {
      this.#local.disconnect(
        workerId,
        continuityMatches
          ? "Worker relay claim was lost"
          : existing.ownerId === resolvedOwnerId
            ? "Worker continuity identity changed"
            : "Worker owner changed",
        continuityMatches ? 1012 : 1008,
      );
    }
    const connectionId = randomUUID();
    const previous = await this.#coordinator.claimWorker({
      connectionId,
      ownerId: resolvedOwnerId,
      workerId,
    });
    if (
      !this.#isCurrentAttachment(workerId, attachmentGeneration) ||
      !workerSocketIsAttachable(socket)
    ) {
      await this.#discardSupersededClaim(workerId, connectionId, socket);
      return false;
    }
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
      if (
        !this.#isCurrentAttachment(workerId, attachmentGeneration) ||
        !workerSocketIsAttachable(socket)
      ) {
        await this.#discardSupersededClaim(workerId, connectionId, socket);
        return false;
      }
    }

    if (!workerSocketIsAttachable(socket)) {
      await this.#discardSupersededClaim(workerId, connectionId, socket);
      return false;
    }

    const connection: LocalConnection = {
      connectionId,
      continuityIdentity,
      ownerId: resolvedOwnerId,
      unsubscribers: [],
    };
    this.#connections.set(workerId, connection);
    this.#knownRemoteWorkers.delete(workerId);
    connection.unsubscribers.push(
      this.#local.subscribeWorkerDisconnect(workerId, () => {
        const current = this.#connections.get(workerId);
        if (current?.connectionId === connectionId) {
          this.#dispatchDisconnect(workerId);
        }
      }),
      this.#local.subscribeWorkerOffline(workerId, () => {
        void this.#localOffline(workerId, connectionId);
      }),
      this.#local.subscribeSurfaceFrames(workerId, (header, payload) => {
        if (this.#connections.get(workerId)?.connectionId !== connectionId)
          return;
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
          if (this.#connections.get(workerId)?.connectionId !== connectionId)
            return;
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
      this.#local.subscribeWorkerLinkFrames(workerId, (frame) => {
        if (this.#connections.get(workerId)?.connectionId !== connectionId)
          return;
        this.#dispatchFrame(
          "worker-link",
          workerId,
          frame.header,
          frame.payload,
          frame,
        );
        this.#publishWorkerFrame(
          "from-worker",
          "worker-link",
          resolvedOwnerId,
          workerId,
          frame.header,
          frame.payload,
        );
      }),
      this.#local.subscribeNotifications(workerId, (notification) => {
        if (this.#connections.get(workerId)?.connectionId !== connectionId)
          return;
        this.#dispatchNotification(workerId, notification);
        this.#publishBounded({
          kind: "worker-notification",
          ownerId: resolvedOwnerId,
          workerId,
          notification,
        });
      }),
    );
    const accepted = this.#local.attach(
      workerId,
      socket,
      resolvedOwnerId,
      continuityIdentity,
    );
    if (!accepted) {
      if (this.#connections.get(workerId) === connection) {
        this.#connections.delete(workerId);
        for (const unsubscribe of connection.unsubscribers) unsubscribe();
      }
      await this.#discardSupersededClaim(workerId, connectionId, socket);
      return false;
    }
    serverLogger.event("info", "Worker attached to relay instance", {
      event: "coordination.worker.attached",
      subsystem: "relay-coordination",
      operation: "attach-worker",
      status: "online",
      workerId,
      replacedRemoteClaim: Boolean(previous),
    });
    return true;
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const startedAtMs = Date.now();
    serverLogger.event("info", "Coordinated worker bridge shutdown began", {
      event: "coordination.bridge.shutdown-started",
      subsystem: "relay-coordination",
      operation: "close",
      status: "stopping",
      counts: {
        localWorkers: this.#connections.size,
        pendingRequests: this.#pending.size,
      },
    });
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
    this.#attachmentGenerations.clear();
    this.#local.close();
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new WorkerUnavailableError("Server is shutting down."));
    }
    this.#pending.clear();
    this.#disconnectListeners.clear();
    this.#offlineListeners.clear();
    this.#notificationListeners.clear();
    this.#surfaceListeners.clear();
    this.#tunnelListeners.clear();
    this.#workerLinkListeners.clear();
    this.#knownRemoteWorkers.clear();
    await Promise.allSettled(releases);
    serverLogger.event("info", "Coordinated worker bridge stopped", {
      event: "coordination.bridge.shutdown-completed",
      subsystem: "relay-coordination",
      operation: "close",
      status: "stopped",
      durationMs: Date.now() - startedAtMs,
    });
  }

  disconnect(workerId: string, reason?: string, code?: number): void {
    const attachmentGeneration = Symbol(workerId);
    this.#attachmentGenerations.set(workerId, attachmentGeneration);
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
          if (
            !remote ||
            !this.#isCurrentAttachment(workerId, attachmentGeneration)
          ) {
            return;
          }
          this.#knownRemoteWorkers.set(workerId, remote.connectionId);
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
    this.#knownRemoteWorkers.set(workerId, presence.connectionId);
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
    if (this.#connections.has(workerId))
      return this.#local.isConnected(workerId);
    const presence = this.#coordinator.cachedWorker(workerId);
    if (presence) {
      this.#knownRemoteWorkers.set(workerId, presence.connectionId);
      return true;
    }
    return false;
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
    if (this.#connections.has(workerId)) {
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

  sendWorkerLinkFrame(
    workerId: string,
    frame: ValidatedWorkerLinkFrame,
  ): boolean {
    return this.#sendFrame(
      "worker-link",
      workerId,
      frame.header,
      frame.payload,
      frame,
    );
  }

  subscribeWorkerDisconnect(
    workerId: string,
    listener: () => void,
  ): () => void {
    return this.#subscribe(this.#disconnectListeners, workerId, listener);
  }

  subscribeWorkerOffline(workerId: string, listener: () => void): () => void {
    return this.#subscribe(this.#offlineListeners, workerId, listener);
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

  subscribeWorkerLinkFrames(
    workerId: string,
    listener: WorkerLinkFrameListener,
  ): () => void {
    return this.#subscribe(this.#workerLinkListeners, workerId, listener);
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
      serverLogger.rateLimited(
        "coordination-command-queue-full",
        "warn",
        "Shared worker command queue is full",
        {
          event: "coordination.command.rejected",
          subsystem: "relay-coordination",
          operation: command.type,
          reasonCode: "queue-full",
          status: "rejected",
          workerId,
        },
      );
      throw new Error("The shared worker command queue is full.");
    }
    const presence = await this.#coordinator.findWorker(workerId);
    if (!presence) {
      this.#failedRequests += 1;
      serverLogger.rateLimited(
        `coordination-command-offline:${workerId}:${command.type}`,
        "warn",
        "Remote worker command could not be dispatched",
        {
          event: "coordination.command.rejected",
          subsystem: "relay-coordination",
          operation: command.type,
          reasonCode: "worker-offline",
          status: "rejected",
          workerId,
        },
      );
      throw new WorkerUnavailableError(`Worker ${workerId} is offline.`);
    }
    this.#knownRemoteWorkers.set(workerId, presence.connectionId);
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
    const startedAtMs = Date.now();
    this.#routedRequests += 1;
    serverLogger.event("debug", "Remote worker command dispatched", {
      event: "coordination.command.dispatched",
      subsystem: "relay-coordination",
      operation: command.type,
      requestId,
      status: "dispatched",
      workerId,
    });
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(requestId);
        this.#failedRequests += 1;
        serverLogger.event("warn", "Remote worker command timed out", {
          event: "coordination.command.timed-out",
          subsystem: "relay-coordination",
          operation: command.type,
          requestId,
          reasonCode: "timeout",
          status: "failed",
          durationMs: Date.now() - startedAtMs,
          workerId,
        });
        reject(
          new WorkerCommandError(
            `Worker command ${command.type} timed out.`,
            "worker-command-timeout",
            { operation: command.type, requestId, workerId },
          ),
        );
      }, timeoutMs);
      timeout.unref();
      this.#pending.set(requestId, {
        commandType: command.type,
        eventQueue: Promise.resolve(),
        onEvent: options.onEvent,
        reject,
        resolve,
        startedAtMs,
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
          serverLogger.event("error", "Remote worker command relay failed", {
            event: "coordination.command.dispatch-failed",
            subsystem: "relay-coordination",
            operation: command.type,
            requestId,
            reasonCode: "coordination-publish-failed",
            status: "failed",
            durationMs: Date.now() - startedAtMs,
            workerId,
          });
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
        const eventQueue = pending.eventQueue.then(() =>
          pending.onEvent?.(event.data),
        );
        pending.eventQueue = eventQueue;
        void eventQueue
          .catch((error: unknown) => {
            if (this.#pending.get(message.requestId) !== pending) return;
            clearTimeout(pending.timeout);
            this.#pending.delete(message.requestId);
            this.#failedRequests += 1;
            serverLogger.event(
              "warn",
              "Remote worker command event handling failed",
              {
                event: "coordination.command.event-handler-failed",
                subsystem: "relay-coordination",
                operation: pending.commandType,
                requestId: message.requestId,
                reasonCode: "event-handler-failed",
                status: "failed",
                durationMs: Date.now() - pending.startedAtMs,
                workerId: pending.workerId,
              },
            );
            pending.reject(
              error instanceof Error ? error : new Error(String(error)),
            );
          })
          .catch(() => undefined);
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
          serverLogger.event("debug", "Remote worker command completed", {
            event: "coordination.command.completed",
            subsystem: "relay-coordination",
            operation: pending.commandType,
            requestId: message.requestId,
            status: "completed",
            durationMs: Date.now() - pending.startedAtMs,
            workerId: pending.workerId,
          });
          pending.resolve(message.result);
        } else {
          this.#failedRequests += 1;
          const errorCode = stableWorkerFailureCode(message.errorCode);
          serverLogger.event("warn", "Remote worker command failed", {
            event: "coordination.command.failed",
            subsystem: "relay-coordination",
            operation: pending.commandType,
            requestId: message.requestId,
            reasonCode: errorCode ?? "remote-worker-failure",
            status: "failed",
            durationMs: Date.now() - pending.startedAtMs,
            workerId: pending.workerId,
          });
          pending.reject(
            new WorkerCommandError(
              message.error ?? "Remote worker command failed.",
              errorCode,
              {
                operation: pending.commandType,
                requestId: message.requestId,
                workerId: pending.workerId,
              },
            ),
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
            this.#knownRemoteWorkers.set(
              message.presence.workerId,
              message.presence.connectionId,
            );
          }
        } else {
          const workerId = message.presence.workerId;
          if (this.#connections.has(workerId)) return;
          if (
            this.#knownRemoteWorkers.get(workerId) !==
              message.presence.connectionId ||
            this.#coordinator.cachedWorker(workerId)
          ) {
            return;
          }
          this.#knownRemoteWorkers.delete(workerId);
          this.#dispatchDisconnect(workerId);
          this.#dispatchOffline(workerId);
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
      serverLogger.rateLimited(
        "coordination-incoming-command-busy",
        "warn",
        "Incoming worker command relay is busy",
        {
          event: "coordination.command.rejected",
          subsystem: "relay-coordination",
          operation: "receive-command",
          reasonCode: "incoming-limit",
          status: "rejected",
          workerId: message.workerId,
        },
      );
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
    const attachmentGeneration = this.#attachmentGenerations.get(
      message.workerId,
    );
    const ownerId = await this.#resolveOwnerId(message.workerId);
    const remainingTimeoutMs = Math.min(
      message.timeoutMs,
      message.expiresAt - Date.now(),
      MAX_REMOTE_COMMAND_LIFETIME_MS,
    );
    if (remainingTimeoutMs <= 0) return;
    if (
      !command.success ||
      !local ||
      this.#connections.get(message.workerId) !== local ||
      this.#attachmentGenerations.get(message.workerId) !==
        attachmentGeneration ||
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
        timeoutMs: remainingTimeoutMs,
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
      await this.#respond(
        message,
        false,
        undefined,
        errorMessage(error),
        error instanceof WorkerCommandError
          ? (error.code ?? undefined)
          : undefined,
      );
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
    errorCode?: string,
  ): Promise<void> {
    await this.#coordinator.publish(
      {
        kind: "worker-command-response",
        targetInstanceId: request.sourceInstanceId,
        requestId: request.requestId,
        ok,
        result,
        error,
        errorCode,
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
        return;
      }
      case "worker-link": {
        const header = workerLinkFrameHeaderSchema.safeParse(message.header);
        if (header.success) {
          this.#local.sendWorkerLinkFrame(
            message.workerId,
            createWorkerLinkFrame(header.data, payload),
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
    workerLinkFrame?: ValidatedWorkerLinkFrame,
  ): boolean {
    if (this.#connections.has(workerId)) {
      switch (transport) {
        case "surface":
          return this.#local.sendSurfaceFrame(
            workerId,
            header as RemoteSurfaceFrameHeader,
            payload,
          );
        case "tunnel":
          return this.#local.sendTunnelDataPlaneFrame(
            workerId,
            header as TunnelDataPlaneFrameHeader,
            payload,
          );
        case "worker-link":
          return workerLinkFrame
            ? this.#local.sendWorkerLinkFrame(workerId, workerLinkFrame)
            : false;
      }
    }
    const presence = this.#coordinator.cachedWorker(workerId);
    if (!presence) return false;
    this.#knownRemoteWorkers.set(workerId, presence.connectionId);
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
    workerLinkFrame?: ValidatedWorkerLinkFrame,
  ): void {
    if (transport === "surface") {
      const parsed = remoteSurfaceFrameHeaderSchema.safeParse(header);
      if (!parsed.success) return;
      for (const listener of this.#surfaceListeners.get(workerId) ?? []) {
        listener(parsed.data, payload);
      }
      return;
    }
    if (transport === "tunnel") {
      const parsed = tunnelDataPlaneFrameHeaderSchema.safeParse(header);
      if (!parsed.success) return;
      for (const listener of this.#tunnelListeners.get(workerId) ?? []) {
        listener(parsed.data, payload);
      }
      return;
    }
    const parsed = workerLinkFrameHeaderSchema.safeParse(header);
    if (!parsed.success) return;
    const frame =
      workerLinkFrame ?? createWorkerLinkFrame(parsed.data, payload);
    for (const listener of this.#workerLinkListeners.get(workerId) ?? []) {
      listener(frame);
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

  #dispatchOffline(workerId: string): void {
    for (const listener of this.#offlineListeners.get(workerId) ?? []) {
      listener();
    }
  }

  async #localOffline(workerId: string, connectionId: string): Promise<void> {
    const connection = this.#connections.get(workerId);
    if (!connection || connection.connectionId !== connectionId) return;
    this.#connections.delete(workerId);
    for (const unsubscribe of connection.unsubscribers) unsubscribe();
    this.#dispatchOffline(workerId);
    try {
      await this.#coordinator.releaseWorker(workerId, connectionId);
    } catch {
      serverLogger.rateLimited(
        `coordination-worker-release-failed:${workerId}`,
        "warn",
        "Worker relay ownership could not be released",
        {
          event: "coordination.worker.release-failed",
          subsystem: "relay-coordination",
          operation: "release-worker",
          reasonCode: "coordination-unavailable",
          status: "degraded",
          workerId,
        },
      );
    }
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
        if (
          this.#connections.get(workerId)?.connectionId !==
          connection.connectionId
        ) {
          continue;
        }
        serverLogger.event("warn", "Worker relay claim was lost", {
          event: "coordination.worker.claim-lost",
          subsystem: "relay-coordination",
          operation: "refresh-worker",
          reasonCode: "claim-replaced",
          status: "reconnecting",
          workerId,
        });
        this.#local.disconnect(
          workerId,
          "Worker connection was claimed by another server instance",
          1012,
        );
      }
    }
    const observedWorkers = new Set([
      ...this.#knownRemoteWorkers.keys(),
      ...this.#surfaceListeners.keys(),
      ...this.#tunnelListeners.keys(),
      ...this.#notificationListeners.keys(),
      ...this.#disconnectListeners.keys(),
      ...this.#offlineListeners.keys(),
    ]);
    for (const workerId of observedWorkers) {
      if (this.#connections.has(workerId)) continue;
      const knownConnectionId = this.#knownRemoteWorkers.get(workerId);
      let presence: WorkerPresenceClaim | null;
      try {
        presence = await this.#coordinator.findWorker(workerId);
      } catch {
        continue;
      }
      if (this.#connections.has(workerId)) continue;
      if (presence) {
        this.#knownRemoteWorkers.set(workerId, presence.connectionId);
      } else if (
        this.#knownRemoteWorkers.get(workerId) === knownConnectionId &&
        this.#knownRemoteWorkers.delete(workerId)
      ) {
        this.#dispatchDisconnect(workerId);
        this.#dispatchOffline(workerId);
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

  #isCurrentAttachment(workerId: string, generation: symbol): boolean {
    return (
      !this.#closed && this.#attachmentGenerations.get(workerId) === generation
    );
  }

  async #discardSupersededClaim(
    workerId: string,
    connectionId: string,
    socket: WorkerSocket,
  ): Promise<void> {
    try {
      await this.#coordinator.releaseWorker(workerId, connectionId);
    } catch {
      // The exact-generation release is best effort. A newer claim cannot be
      // removed because RelayCoordinator release is fenced by connectionId.
    }
    socket.close(1012, "Worker connection was superseded");
  }
}
