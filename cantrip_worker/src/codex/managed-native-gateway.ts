import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";

import { CantripServerRequestError } from "../cli-client.js";
import { ManagedNativeQueueUncertainError } from "../managed-native-queue-client.js";
import type { ManagedSessionIdentity } from "./managed-session.js";
import {
  isManagedNativeQueueMethod,
  type ManagedNativeQueueGateway,
} from "./managed-native-queue.js";
import {
  managedNativeMethods,
  managedNativeServerRequests,
  type ManagedNativeMethodKind,
  type NativeCommandAdmission,
} from "@cantrip/protocol";

export type NativeRpcId = string | number;
export type NativeRpcFrame = Record<string, unknown>;
export interface ManagedNativeGatewayIdentity extends ManagedSessionIdentity {
  threadId: string;
  runtimeGeneration: string;
  modelRouteId: string | null;
  providerAccountId: string | null;
}
export interface ManagedNativeOperation {
  settingsBindingId?: string;
  operationId: string;
  expectedTurnId?: string;
  queueClaim?: { id: string; promptRevision: number };
  goalQueueHandoff?: NativeCommandAdmission["goalQueueHandoff"];
  origin: "terminal" | "gui" | "autonomous";
  identity: Readonly<ManagedNativeGatewayIdentity>;
  connectionId: string | null;
  kind: Exclude<ManagedNativeMethodKind, "read"> | "reply";
  method: string;
  /** Worker-local only. The server admission adapter sends a digest/protected payload. */
  frame: NativeRpcFrame;
  reply?: {
    nativeRequestId: NativeRpcId;
    requestMethod: string;
    turnId: string | null;
  };
}
export interface ManagedNativeAdmission {
  operationGeneration: string;
  /** Revalidates/dispatches the exact server generation and registers execution authority. */
  beforeForward(): Promise<void>;
  /** Called before reporting a native receipt to the TUI. Missing receipt is uncertain. */
  settle(receipt: NativeRpcFrame | null): Promise<void>;
  /** An explicitly authorized native rewrite, e.g. managed chat settings/default scope. */
  forward?: { method: string; params: Record<string, unknown> };
}
export interface ManagedNativeGatewayOptions {
  identity: ManagedNativeGatewayIdentity;
  upstreamUrl: string;
  /** Canonical managed queue; its mutations settle atomically with their server command. */
  queue?: ManagedNativeQueueGateway;
  isCurrent(): boolean;
  admit(operation: ManagedNativeOperation): Promise<ManagedNativeAdmission>;
  /** Dispatches through the runtime's single GUI/TUI pending resolver, never a second native socket. */
  resolveReply(
    operation: ManagedNativeOperation,
    response: NativeRpcFrame,
    operationGeneration: string,
  ): Promise<void>;
  /** Optional additional observer; omit when the runtime already observes this subscription. */
  onNativeMessage?(message: NativeRpcFrame, connectionId: string): void;
}
export interface ManagedNativeGateway {
  /** Capability URL for this exact runtime incarnation; never the native endpoint. */
  url: string;
  close(): Promise<void>;
}
interface ReplyEntry {
  method: string;
  params: unknown;
  turnId: string | null;
  connections: Set<string>;
  state: "pending" | "resolving" | "resolved";
}
interface PendingRequest {
  admission?: ManagedNativeAdmission;
  forwarded: boolean;
  method: string;
}
const key = (id: NativeRpcId) => `${typeof id}:${id}`;
const object = (value: unknown): value is NativeRpcFrame =>
  !!value && typeof value === "object" && !Array.isArray(value);
const rpcId = (value: unknown): value is NativeRpcId =>
  typeof value === "string" ||
  (typeof value === "number" && Number.isSafeInteger(value));
const fault = (id: unknown, message: string, code = -32001) => ({
  id: rpcId(id) ? id : null,
  error: { code, message },
});

/**
 * One upstream connection per view preserves native subscription semantics.
 * All views share an approval ledger. No queue is held through model work or
 * admission waits: Stop and replies can progress while a start is pending.
 */
export async function createManagedNativeGateway(
  options: ManagedNativeGatewayOptions,
): Promise<ManagedNativeGateway> {
  const identity = Object.freeze({ ...options.identity });
  const upstreamUrl = options.upstreamUrl;
  const capabilityPath = `/managed/${randomBytes(32).toString("hex")}`;
  const server = createServer((_request, response) =>
    response.writeHead(404).end(),
  );
  const sockets = new WebSocketServer({
    noServer: true,
    maxPayload: 32 * 1024 * 1024,
  });
  const views = new Set<{ close(): void }>();
  const replies = new Map<string, ReplyEntry>();
  let stopped = false;
  const current = () => !stopped && options.isCurrent();
  const validateScope = (frame: NativeRpcFrame) => {
    if (!object(frame.params)) return;
    if (
      frame.method === "thread/resume" &&
      (frame.params.path != null || frame.params.history != null)
    ) {
      throw new Error("Managed resume must use its bound native thread ID.");
    }
    for (const name of [
      "threadId",
      "thread_id",
      "conversationId",
      "conversation_id",
    ]) {
      const target = frame.params[name];
      if (target !== undefined && target !== identity.threadId) {
        throw new Error("Native request targets another managed session.");
      }
    }
  };
  server.on("upgrade", (request, socket, head) => {
    const actual = Buffer.from(request.url ?? "");
    const expected = Buffer.from(capabilityPath);
    if (
      !current() ||
      request.headers.origin ||
      actual.length !== expected.length ||
      !timingSafeEqual(actual, expected)
    ) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    sockets.handleUpgrade(request, socket, head, (client) =>
      sockets.emit("connection", client),
    );
  });
  sockets.on("connection", (client) => {
    const connectionId = randomUUID();
    const upstream = new WebSocket(upstreamUrl, {
      maxPayload: 32 * 1024 * 1024,
    });
    const pending = new Map<string, PendingRequest>();
    let disconnected = false;
    let initialized = false;
    const lifetime = new AbortController();
    let unsubscribeQueue: (() => void) | undefined;
    const send = (socket: WebSocket, frame: NativeRpcFrame) => {
      if (socket.readyState !== WebSocket.OPEN)
        throw new Error("Native connection is unavailable.");
      socket.send(JSON.stringify(frame));
    };
    const fail = (id: unknown, error: unknown) => {
      if (client.readyState === WebSocket.OPEN) {
        const frame = fault(
          id,
          error instanceof Error ? error.message : "Native operation rejected.",
        );
        if (
          error instanceof CantripServerRequestError ||
          error instanceof ManagedNativeQueueUncertainError
        )
          Object.assign(frame.error, {
            data: {
              code: error.code,
              ...(error instanceof CantripServerRequestError
                ? { status: error.status }
                : {}),
            },
          });
        send(client, frame);
      }
    };
    const upstreamReady = new Promise<void>((resolve, reject) => {
      upstream.once("open", resolve);
      upstream.once("error", reject);
      upstream.once("close", () =>
        reject(new Error("Native connection closed before initialization.")),
      );
    });
    void upstreamReady.catch(() => {});
    const active = () => !disconnected && current();
    const close = () => {
      if (disconnected) return;
      disconnected = true;
      lifetime.abort(new Error("Managed native view disconnected."));
      unsubscribeQueue?.();
      views.delete(view);
      for (const entry of pending.values()) {
        if (entry.forwarded && entry.admission)
          void entry.admission.settle(null).catch(() => {});
      }
      pending.clear();
      for (const [id, entry] of replies) {
        entry.connections.delete(connectionId);
        if (entry.connections.size === 0) replies.delete(id);
      }
      client.terminate();
      upstream.terminate();
    };
    const view = { close };
    views.add(view);
    client.on("close", close);
    client.on("error", close);
    upstream.on("close", close);
    upstream.on("error", close);
    unsubscribeQueue = options.queue?.subscribe((change) => {
      if (!initialized || !active()) return;
      if (change.threadId !== identity.threadId) return;
      try {
        send(client, {
          method: "thread/queue/changed",
          params: {
            threadId: identity.threadId,
            managedQueue: { revision: change.revision },
          },
        });
      } catch {
        close();
      }
    });

    const forwardRequest = async (frame: NativeRpcFrame) => {
      if (!rpcId(frame.id) || typeof frame.method !== "string")
        throw new Error("Invalid native RPC request.");
      const id = key(frame.id);
      if (pending.has(id))
        throw new Error("Duplicate in-flight native request ID.");
      if (pending.size >= 1024)
        throw new Error("Too many pending native requests.");
      const kind = managedNativeMethods.get(frame.method);
      if (!kind)
        throw new Error(`Unsupported managed native method: ${frame.method}`);
      if (!initialized && frame.method !== "initialize")
        throw new Error("Native view must initialize first.");
      if (initialized && frame.method === "initialize")
        throw new Error("Native view is already initialized.");
      validateScope(frame);
      const entry: PendingRequest = { forwarded: false, method: frame.method };
      pending.set(id, entry);
      try {
        if (options.queue && isManagedNativeQueueMethod(frame.method)) {
          if (
            !object(frame.params) ||
            frame.params.threadId !== identity.threadId
          )
            throw new Error(
              "Managed queue requests require their exact bound thread ID.",
            );
          const result = await options.queue.execute({
            method: frame.method,
            params: frame.params,
            identity,
            connectionId,
            signal: lifetime.signal,
            assertCurrent() {
              if (!active())
                throw new Error(
                  "Managed queue session expired before dispatch.",
                );
            },
          });
          pending.delete(id);
          if (active()) send(client, { id: frame.id, result });
          return;
        }
        let forwarded = frame;
        if (kind !== "read") {
          const admission = await options.admit({
            operationId: randomUUID(),
            origin: "terminal",
            identity,
            connectionId,
            kind,
            method: frame.method,
            frame,
          });
          if (!admission.operationGeneration)
            throw new Error("Missing native operation generation.");
          entry.admission = admission;
          if (admission.forward) {
            forwarded = { ...frame, ...admission.forward };
            if (!managedNativeMethods.has(admission.forward.method))
              throw new Error("Unsupported admitted native rewrite.");
            validateScope(forwarded);
          }
          await upstreamReady;
          if (!active())
            throw new Error("Managed native session expired before dispatch.");
          await admission.beforeForward();
        } else {
          await upstreamReady;
        }
        if (!active())
          throw new Error("Managed native session expired before dispatch.");
        entry.forwarded = true;
        send(upstream, forwarded);
      } catch (error) {
        pending.delete(id);
        // No native dispatch occurred; persist a definite rejection where admission exists.
        if (entry.admission)
          await entry.admission
            .settle(fault(frame.id, "Native dispatch did not complete."))
            .catch(() => {});
        throw error;
      }
    };
    const forwardReply = async (frame: NativeRpcFrame) => {
      if (!rpcId(frame.id)) throw new Error("Invalid native reply ID.");
      const entry = replies.get(key(frame.id));
      if (
        !entry ||
        !entry.connections.has(connectionId) ||
        entry.state !== "pending"
      ) {
        throw new Error("Native reply is stale, foreign, or already resolved.");
      }
      if ("result" in frame === "error" in frame)
        throw new Error("Invalid native reply envelope.");
      entry.state = "resolving";
      let admission: ManagedNativeAdmission | undefined;
      let forwarded = false;
      try {
        const operation: ManagedNativeOperation = {
          operationId: randomUUID(),
          origin: "terminal",
          identity,
          connectionId,
          kind: "reply",
          method: entry.method,
          frame,
          reply: {
            nativeRequestId: frame.id,
            requestMethod: entry.method,
            turnId: entry.turnId,
          },
        };
        admission = await options.admit(operation);
        if (!admission.operationGeneration)
          throw new Error("Missing native operation generation.");
        await admission.beforeForward();
        if (!active())
          throw new Error("Managed native session expired before reply.");
        await options.resolveReply(
          operation,
          frame,
          admission.operationGeneration,
        );
        forwarded = true;
        entry.state = "resolved";
        // Native replies have no JSON-RPC response. This is delivery, not application.
        await admission.settle({ id: frame.id, delivered: true });
        return {
          delivered: true,
          operationGeneration: admission.operationGeneration,
        };
      } catch (error) {
        if (!forwarded) entry.state = "pending";
        if (admission)
          await admission
            .settle(
              forwarded
                ? null
                : fault(frame.id, "Native reply was not dispatched."),
            )
            .catch(() => {});
        throw error;
      }
    };
    client.on("message", (raw, binary) => {
      let frame: NativeRpcFrame | undefined;
      try {
        const parsed: unknown = JSON.parse(raw.toString());
        if (binary || !object(parsed))
          throw new Error("Invalid native JSON-RPC envelope.");
        frame = parsed;
        if (!active()) throw new Error("Managed native session expired.");
      } catch (error) {
        fail(frame?.id, error);
        return;
      }
      if (typeof frame.method === "string" && !("id" in frame)) {
        if (frame.method !== "initialized" || !initialized) {
          fail(null, new Error("Unsupported native notification."));
          return;
        }
        try {
          send(upstream, frame);
        } catch (error) {
          fail(null, error);
        }
        return;
      }
      if (frame.method === "cantrip/managed/reply") {
        const wrapper = frame;
        if (
          !rpcId(wrapper.id) ||
          !object(wrapper.params) ||
          !rpcId(wrapper.params.requestId) ||
          "result" in wrapper.params === "error" in wrapper.params
        ) {
          fail(wrapper.id, new Error("Invalid managed native reply envelope."));
          return;
        }
        const wrapperId = key(wrapper.id);
        if (!initialized || pending.has(wrapperId) || pending.size >= 1024) {
          fail(
            wrapper.id,
            new Error("Invalid or duplicate in-flight managed reply request."),
          );
          return;
        }
        pending.set(wrapperId, {
          forwarded: false,
          method: wrapper.method as string,
        });
        const reply = {
          id: wrapper.params.requestId,
          ...("result" in wrapper.params
            ? { result: wrapper.params.result }
            : { error: wrapper.params.error }),
        };
        void forwardReply(reply)
          .then((receipt) => {
            if (active()) send(client, { id: wrapper.id, result: receipt });
          })
          .catch((error) => fail(wrapper.id, error))
          .finally(() => pending.delete(wrapperId));
        return;
      }
      const task =
        typeof frame.method === "string"
          ? forwardRequest(frame)
          : forwardReply(frame);
      void task.catch((error) => fail(frame.id, error));
    });
    upstream.on("message", (raw, binary) => {
      void (async () => {
        const parsed: unknown = JSON.parse(raw.toString());
        if (binary || !object(parsed))
          throw new Error("Invalid upstream native envelope.");
        const frame = parsed;
        if (!active()) {
          close();
          return;
        }
        if (typeof frame.method === "string" && rpcId(frame.id)) {
          if (!managedNativeServerRequests.has(frame.method)) {
            send(
              upstream,
              fault(
                frame.id,
                "Unsupported managed native server request.",
                -32601,
              ),
            );
            return;
          }
          validateScope(frame);
          const id = key(frame.id);
          const existing = replies.get(id);
          const params = JSON.stringify(frame.params);
          if (
            existing &&
            (existing.method !== frame.method ||
              JSON.stringify(existing.params) !== params)
          ) {
            throw new Error("Native request identity collision.");
          }
          const entry = existing ?? {
            method: frame.method,
            params: frame.params,
            turnId:
              object(frame.params) && typeof frame.params.turnId === "string"
                ? frame.params.turnId
                : null,
            connections: new Set<string>(),
            state: "pending" as const,
          };
          entry.connections.add(connectionId);
          replies.set(id, entry);
        } else if (rpcId(frame.id)) {
          const entry = pending.get(key(frame.id));
          if (!entry) throw new Error("Uncorrelated native response.");
          pending.delete(key(frame.id));
          if (entry.admission) await entry.admission.settle(frame);
          else if (entry.method === "initialize" && object(frame.result)) {
            initialized = true;
            frame.result = {
              ...frame.result,
              cantripManagedGateway: {
                version: 1,
                replyMethod: "cantrip/managed/reply",
                threadId: identity.threadId,
                ...(options.queue ? { queue: { version: 1 } } : {}),
              },
            };
          }
          if (object(frame.result) && Array.isArray(frame.result.data)) {
            if (entry.method === "thread/loaded/list") {
              frame.result = {
                ...frame.result,
                data: frame.result.data.filter(
                  (id) => id === identity.threadId,
                ),
              };
            } else if (entry.method === "thread/list") {
              frame.result = {
                ...frame.result,
                data: frame.result.data.filter(
                  (thread) => object(thread) && thread.id === identity.threadId,
                ),
              };
            }
          }
        }
        if (
          frame.method === "serverRequest/resolved" &&
          object(frame.params) &&
          frame.params.threadId === identity.threadId &&
          rpcId(frame.params.requestId)
        ) {
          replies.delete(key(frame.params.requestId));
        }
        // A managed view has one queue owner; native scheduler invalidations
        // must not be mistaken for canonical queue changes.
        if (options.queue && frame.method === "thread/queue/changed") return;
        options.onNativeMessage?.(frame, connectionId);
        send(client, frame);
      })().catch((error) => {
        fail(null, error);
        close();
      });
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Managed native gateway did not bind.");
  return {
    url: `ws://127.0.0.1:${address.port}${capabilityPath}`,
    async close() {
      if (stopped) return;
      stopped = true;
      for (const view of [...views]) view.close();
      replies.clear();
      await new Promise<void>((resolve) => sockets.close(() => resolve()));
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    },
  };
}
