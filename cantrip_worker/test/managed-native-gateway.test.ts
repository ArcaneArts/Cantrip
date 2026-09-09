import { once } from "node:events";
import { readFile } from "node:fs/promises";
import WebSocket, { WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { managedNativeMethods } from "@cantrip/protocol";
import {
  createManagedNativeGateway,
  type ManagedNativeAdmission,
  type ManagedNativeGatewayIdentity,
  type ManagedNativeOperation,
} from "../src/codex/managed-native-gateway.js";

import { CantripServerRequestError } from "../src/cli-client.js";
import { ManagedNativeQueueUncertainError } from "../src/managed-native-queue-client.js";
import { ManagedNativeQueueScope } from "../src/codex/managed-native-queue-scope.js";
import {
  managedNativeQueueMethods,
  type ManagedNativeQueueGateway,
  type ManagedNativeQueueChange,
} from "../src/codex/managed-native-queue.js";

const identity: ManagedNativeGatewayIdentity = {
  serverId: "server",
  ownerId: "owner",
  workerId: "worker",
  chatId: "chat",
  projectId: "project",
  contextKind: "project",
  placementId: "worktree",
  threadId: "bound-thread",
  runtimeGeneration: "runtime-one",
  modelRouteId: "route",
  providerAccountId: null,
};
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close();
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
async function fixture(
  admit: (operation: ManagedNativeOperation) => Promise<ManagedNativeAdmission>,
  queue?: ManagedNativeQueueGateway,
  scopeCurrent: () => boolean = () => true,
) {
  const native = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(native, "listening");
  const messages: any[] = [];
  const peers: WebSocket[] = [];
  native.on("connection", (socket) => {
    peers.push(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(raw.toString());
      messages.push(frame);
      if (frame.method && frame.id !== undefined)
        socket.send(
          JSON.stringify({
            id: frame.id,
            result:
              frame.method === "initialize"
                ? { userAgent: "fixture" }
                : { accepted: frame.method },
          }),
        );
    });
  });
  cleanups.push(async () => {
    for (const socket of native.clients) socket.terminate();
    await new Promise<void>((resolve) => native.close(() => resolve()));
  });
  let active = true;
  const gateway = await createManagedNativeGateway({
    identity,
    queue,
    upstreamUrl: `ws://127.0.0.1:${(native.address() as any).port}`,
    admit,
    isCurrent: () => active && scopeCurrent(),
    resolveReply: async (_operation, frame) => {
      messages.push(frame);
    },
  });
  cleanups.push(() => gateway.close());
  const client = new WebSocket(gateway.url);
  const received: any[] = [];
  client.on("message", (raw) => received.push(JSON.parse(raw.toString())));
  await once(client, "open");
  let nextId = 1;
  const request = async (method: string, params: any = {}) => {
    const id = nextId++;
    client.send(JSON.stringify({ id, method, params }));
    await vi.waitFor(() =>
      expect(received.some((frame) => frame.id === id)).toBe(true),
    );
    return received.find((frame) => frame.id === id);
  };
  await request("initialize");
  client.send(JSON.stringify({ method: "initialized" }));
  return {
    gateway,
    client,
    messages,
    received,
    peers,
    request,
    expire: () => {
      active = false;
    },
  };
}
const admitted = (settle = vi.fn(async () => {})): ManagedNativeAdmission => ({
  operationGeneration: "operation-one",
  beforeForward: vi.fn(async () => {}),
  settle,
});

describe("managed native gateway", () => {
  it("classifies every pinned request explicitly, including reviewed patch additions", async () => {
    const source = await readFile(
      new URL(
        "../../cantrip_codex/upstream/codex-rs/app-server-protocol/src/protocol/common.rs",
        import.meta.url,
      ),
      "utf8",
    );
    const methods = [...source.matchAll(/^    \w+ => "([^"]+)" \{/gm)].map(
      (match) => match[1]!,
    );
    // The common file also defines server requests after the client request macro.
    const requests = methods.slice(
      0,
      methods.indexOf("item/commandExecution/requestApproval"),
    );
    expect(
      requests.filter((method) => !managedNativeMethods.has(method)),
    ).toEqual([]);
    expect(managedNativeMethods.get("thread/managedConfig/update")).toBe(
      "settings",
    );
    expect(managedNativeMethods.get("config/batchWrite")).toBe("defaults");
    expect(managedNativeMethods.get("config/mcpServer/reload")).not.toBe(
      "read",
    );
    expect(managedNativeMethods.get("invented/mutation")).toBeUndefined();
  });

  it("forwards settings reads without a mutation admission or synthetic turn", async () => {
    const admission = vi.fn(async () => admitted());
    const f = await fixture(admission);
    expect(managedNativeMethods.get("thread/settings/read")).toBe("read");
    expect(
      (await f.request("thread/settings/read", { threadId: identity.threadId }))
        .result,
    ).toEqual({ accepted: "thread/settings/read" });
    expect(admission).not.toHaveBeenCalled();
    expect(
      f.messages.filter(
        (frame) =>
          frame.method !== "initialize" && frame.method !== "initialized",
      ),
    ).toEqual([
      expect.objectContaining({
        method: "thread/settings/read",
        params: { threadId: identity.threadId },
      }),
    ]);
  });

  it("admits before actual forwarding and records the actual receipt", async () => {
    const grant = deferred();
    const settle = vi.fn(async () => {});
    const admission = vi.fn(async () => {
      await grant.promise;
      return admitted(settle);
    });
    const f = await fixture(admission);
    const result = f.request("thread/settings/update", {
      threadId: identity.threadId,
      model: "changed",
    });
    await vi.waitFor(() => expect(admission).toHaveBeenCalledTimes(1));
    expect(
      f.messages.filter((frame) => frame.method === "thread/settings/update"),
    ).toEqual([]);
    grant.resolve();
    expect((await result).result).toEqual({
      accepted: "thread/settings/update",
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({
        result: { accepted: "thread/settings/update" },
      }),
    );
    expect(admission.mock.calls[0]![0]).toMatchObject({
      identity,
      origin: "terminal",
      kind: "settings",
    });
  });

  it("rejects denied, unknown, cross-session and expired operations without native mutation", async () => {
    const admission = vi.fn(async () => {
      throw new Error("Policy denied.");
    });
    const f = await fixture(admission);
    expect(
      (await f.request("turn/start", { threadId: identity.threadId })).error
        .message,
    ).toBe("Policy denied.");
    expect((await f.request("unknown/write")).error).toBeDefined();
    expect(
      (await f.request("thread/settings/update", { threadId: "other" })).error,
    ).toBeDefined();
    expect(
      (
        await f.request("thread/resume", {
          threadId: identity.threadId,
          path: "/other.jsonl",
        })
      ).error,
    ).toBeDefined();
    f.expire();
    expect(
      (await f.request("thread/goal/get", { threadId: identity.threadId }))
        .error,
    ).toBeDefined();
    expect(
      f.messages.filter((frame) => frame.id && frame.method !== "initialize"),
    ).toEqual([]);
    expect(admission).toHaveBeenCalledTimes(1);
  });

  it("does not serialize Stop behind a pending start admission", async () => {
    const grant = deferred();
    const f = await fixture(async (operation) => {
      if (operation.kind === "start") await grant.promise;
      return admitted();
    });
    const start = f.request("turn/start", { threadId: identity.threadId });
    const stop = await f.request("turn/interrupt", {
      threadId: identity.threadId,
      turnId: "turn",
    });
    expect(stop.result).toEqual({ accepted: "turn/interrupt" });
    expect(f.messages.some((frame) => frame.method === "turn/start")).toBe(
      false,
    );
    grant.resolve();
    await start;
  });

  it("correlates and admits native approval replies exactly once", async () => {
    const admission = vi.fn(async () => admitted());
    const f = await fixture(admission);
    const nativeRequest = {
      id: "approval",
      method: "item/commandExecution/requestApproval",
      params: {
        threadId: identity.threadId,
        turnId: "turn",
        command: "fixture",
      },
    };
    f.peers[0]!.send(JSON.stringify(nativeRequest));
    await vi.waitFor(() => expect(f.received).toContainEqual(nativeRequest));
    f.client.send(
      JSON.stringify({ id: "approval", result: { decision: "accept" } }),
    );
    await vi.waitFor(() =>
      expect(
        f.messages.filter((frame) => frame.id === "approval"),
      ).toHaveLength(1),
    );
    f.client.send(
      JSON.stringify({ id: "approval", result: { decision: "accept" } }),
    );
    await vi.waitFor(() =>
      expect(
        f.received.some((frame) => frame.id === "approval" && frame.error),
      ).toBe(true),
    );
    expect(f.messages.filter((frame) => frame.id === "approval")).toHaveLength(
      1,
    );
    expect(admission).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "reply",
        reply: {
          nativeRequestId: "approval",
          requestMethod: nativeRequest.method,
          turnId: "turn",
        },
      }),
    );
  });

  it("acknowledges managed replies only after shared resolution and surfaces denial", async () => {
    let allow = false;
    const f = await fixture(async (operation) => {
      if (operation.kind === "reply" && !allow)
        throw new Error("Reply admission denied.");
      return admitted();
    });
    const nativeRequest = {
      id: "question",
      method: "item/tool/requestUserInput",
      params: { threadId: identity.threadId, turnId: "turn" },
    };
    f.peers[0]!.send(JSON.stringify(nativeRequest));
    await vi.waitFor(() => expect(f.received).toContainEqual(nativeRequest));
    expect(
      (
        await f.request("cantrip/managed/reply", {
          requestId: "question",
          result: { answers: {} },
        })
      ).error.message,
    ).toBe("Reply admission denied.");
    expect(f.messages.filter((frame) => frame.id === "question")).toEqual([]);
    allow = true;
    expect(
      (
        await f.request("cantrip/managed/reply", {
          requestId: "question",
          result: { answers: {} },
        })
      ).result,
    ).toEqual({ delivered: true, operationGeneration: "operation-one" });
    expect(f.messages.filter((frame) => frame.id === "question")).toHaveLength(
      1,
    );
    expect(
      (
        await f.request("cantrip/managed/reply", {
          requestId: "question",
          error: { code: -1, message: "late" },
        })
      ).error,
    ).toBeDefined();
  });

  it("reserves managed acknowledgment IDs until admission and resolution finish", async () => {
    const grant = deferred();
    const f = await fixture(async () => {
      await grant.promise;
      return admitted();
    });
    const nativeRequest = {
      id: "question",
      method: "item/tool/requestUserInput",
      params: { threadId: identity.threadId, turnId: "turn" },
    };
    f.peers[0]!.send(JSON.stringify(nativeRequest));
    await vi.waitFor(() => expect(f.received).toContainEqual(nativeRequest));
    f.client.send(
      JSON.stringify({
        id: "shared-id",
        method: "cantrip/managed/reply",
        params: { requestId: "question", result: { answers: {} } },
      }),
    );
    f.client.send(
      JSON.stringify({ id: "shared-id", method: "model/list", params: {} }),
    );
    await vi.waitFor(() =>
      expect(
        f.received.some((frame) => frame.id === "shared-id" && frame.error),
      ).toBe(true),
    );
    expect(f.messages.some((frame) => frame.method === "model/list")).toBe(
      false,
    );
    grant.resolve();
    await vi.waitFor(() =>
      expect(
        f.received.some(
          (frame) => frame.id === "shared-id" && frame.result?.delivered,
        ),
      ).toBe(true),
    );
  });

  it("rechecks incarnation after admission and never forwards stale work", async () => {
    const grant = deferred();
    const settle = vi.fn(async () => {});
    const f = await fixture(async () => {
      await grant.promise;
      return admitted(settle);
    });
    const result = f.request("thread/settings/update", {
      threadId: identity.threadId,
    });
    f.expire();
    grant.resolve();
    expect((await result).error).toBeDefined();
    expect(
      f.messages.some((frame) => frame.method === "thread/settings/update"),
    ).toBe(false);
  });

  it("serves all six canonical queue methods locally after exact thread scoping", async () => {
    const execute = vi.fn(async ({ method }) => ({ canonical: method }));
    const admission = vi.fn(async () => admitted());
    const f = await fixture(admission, { execute, subscribe: () => () => {} });
    expect(f.received[0].result.cantripManagedGateway.queue).toEqual({
      version: 1,
    });
    for (const method of managedNativeQueueMethods) {
      expect(
        (await f.request(method, { threadId: identity.threadId })).result,
      ).toEqual({ canonical: method });
    }
    expect(execute).toHaveBeenCalledTimes(6);
    expect(admission).not.toHaveBeenCalled();
    expect(
      f.messages.filter((frame) => frame.method?.startsWith("thread/queue/")),
    ).toEqual([]);
    expect((await f.request("thread/queue/list", {})).error).toBeDefined();
    expect(
      (await f.request("thread/queue/add", { threadId: "foreign" })).error,
    ).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(6);
  });

  it("invalidates a route-bound gateway capability while the shared admission adapter remains intact", async () => {
    const scope = new ManagedNativeQueueScope(identity);
    const admission = vi.fn(async () => admitted());
    const f = await fixture(admission, undefined, scope.capture());
    await f.request("turn/interrupt", { threadId: identity.threadId });
    expect(admission).toHaveBeenCalledOnce();
    scope.refresh({ ...identity, modelRouteId: "replacement-route" });
    expect(
      (await f.request("turn/interrupt", { threadId: identity.threadId }))
        .error,
    ).toBeDefined();
    expect(admission).toHaveBeenCalledOnce();
  });

  it.each([
    [
      new ManagedNativeQueueUncertainError("ACK lost"),
      "queue-operation-uncertain",
    ],
    [
      new CantripServerRequestError("pending", 409, "queue-receipt-pending"),
      "queue-receipt-pending",
    ],
    [
      new CantripServerRequestError("conflict", 409, "queue-revision-conflict"),
      "queue-revision-conflict",
    ],
  ] as const)(
    "preserves queue error disposition for native retry: %s",
    async (error, code) => {
      const f = await fixture(async () => admitted(), {
        execute: async () => {
          throw error;
        },
        subscribe: () => () => {},
      });
      const result = await f.request("thread/queue/start", {
        threadId: identity.threadId,
      });
      expect(result.error.data.code).toBe(code);
      expect(
        f.messages.some((frame) => frame.method === "thread/queue/start"),
      ).toBe(false);
    },
  );

  it("keeps Stop independent of a canonical start awaiting its actual Turn acknowledgment", async () => {
    const ack = deferred();
    const execute = vi.fn(async () => {
      await ack.promise;
      return { turn: { id: "actual-turn", status: "inProgress", items: [] } };
    });
    const f = await fixture(async () => admitted(), {
      execute,
      subscribe: () => () => {},
    });
    let finished = false;
    const start = f
      .request("thread/queue/start", { threadId: identity.threadId })
      .then((value) => {
        finished = true;
        return value;
      });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    expect(
      (await f.request("turn/interrupt", { threadId: identity.threadId }))
        .result,
    ).toEqual({ accepted: "turn/interrupt" });
    expect(finished).toBe(false);
    ack.resolve();
    expect((await start).result.turn.id).toBe("actual-turn");
  });

  it("fans out canonical revisions to initialized views and suppresses native queue changes", async () => {
    const listeners = new Set<(change: ManagedNativeQueueChange) => void>();
    const f = await fixture(async () => admitted(), {
      execute: async () => ({ data: [], nextCursor: null }),
      subscribe(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    });
    const second = new WebSocket(f.gateway.url);
    const received: any[] = [];
    second.on("message", (raw) => received.push(JSON.parse(raw.toString())));
    await once(second, "open");
    second.send(
      JSON.stringify({ id: "init", method: "initialize", params: {} }),
    );
    await vi.waitFor(() =>
      expect(received.some((frame) => frame.id === "init")).toBe(true),
    );
    for (const listener of listeners)
      listener({ threadId: identity.threadId, revision: "2" });
    const change = {
      method: "thread/queue/changed",
      params: {
        threadId: identity.threadId,
        managedQueue: { revision: "2" },
      },
    };
    await vi.waitFor(() => {
      expect(f.received).toContainEqual(change);
      expect(received).toContainEqual(change);
    });
    for (const listener of listeners)
      listener({ threadId: "foreign", revision: "3" });
    f.peers[0]!.send(
      JSON.stringify({
        method: "thread/queue/changed",
        params: { threadId: identity.threadId },
      }),
    );
    // A later ordered native response proves the native notification was processed.
    await f.request("model/list");
    expect(
      f.received.filter((frame) => frame.method === "thread/queue/changed"),
    ).toEqual([change]);
    second.close();
    await once(second, "close");
    await vi.waitFor(() => expect(listeners.size).toBe(1));
  });

  it("aborts a disconnected queue wait without dispatching or replaying native input", async () => {
    let signal: AbortSignal | undefined;
    const execute = vi.fn(async (request) => {
      signal = request.signal;
      await new Promise<void>((_resolve, reject) =>
        request.signal.addEventListener(
          "abort",
          () => reject(request.signal.reason),
          { once: true },
        ),
      );
      return {};
    });
    const f = await fixture(async () => admitted(), {
      execute,
      subscribe: () => () => {},
    });
    f.client.send(
      JSON.stringify({
        id: "start",
        method: "thread/queue/start",
        params: { threadId: identity.threadId },
      }),
    );
    await vi.waitFor(() => expect(execute).toHaveBeenCalledOnce());
    f.client.close();
    await once(f.client, "close");
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(
      f.messages.some((frame) => frame.method === "thread/queue/start"),
    ).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });

  it("requires the dedicated capability URL", async () => {
    const f = await fixture(async () => admitted());
    const denied = new WebSocket(f.gateway.url.replace(/.$/, "z"));
    const [error] = await once(denied, "error");
    expect(String(error)).toContain("401");
  });
});
