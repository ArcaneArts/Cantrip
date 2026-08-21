import {
  appLiveClientMessageSchema,
  appLiveServerMessageSchema,
} from "@cantrip/protocol";
import type {
  AppLiveClientMessage,
  AppLiveResyncReason,
  AppLiveScope,
  AppLiveServerMessage,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AppLiveClient,
  appLiveWebSocketUrl,
  type AppLiveClientSocket,
  type AppLiveClientStorage,
} from "./app-live-client";

class MemoryStorage implements AppLiveClientStorage {
  readonly values = new Map<string, string>();
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

class FakeSocket implements AppLiveClientSocket {
  readyState = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;
  readonly sent: AppLiveClientMessage[] = [];
  #closeListener: ((event: { code: number; reason: string }) => void) | null =
    null;
  #errorListener: (() => void) | null = null;
  #messageListener: ((data: unknown) => void) | null = null;
  #openListener: (() => void) | null = null;

  close(code = 1000, reason = ""): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCode = code;
    this.closeReason = reason;
    this.#closeListener?.({ code, reason });
  }
  onClose(listener: (event: { code: number; reason: string }) => void): void {
    this.#closeListener = listener;
  }
  onError(listener: () => void): void {
    this.#errorListener = listener;
  }
  onMessage(listener: (data: unknown) => void): void {
    this.#messageListener = listener;
  }
  onOpen(listener: () => void): void {
    this.#openListener = listener;
  }
  send(data: string): void {
    this.sent.push(appLiveClientMessageSchema.parse(JSON.parse(data)));
  }

  open(): void {
    this.readyState = 1;
    this.#openListener?.();
  }

  receive(message: AppLiveServerMessage | string): void {
    this.#messageListener?.(
      typeof message === "string"
        ? message
        : JSON.stringify(appLiveServerMessageSchema.parse(message)),
    );
  }
}

const ready = (
  resume: "not-requested" | "replaying" | "resync-required",
  overrides: Partial<Extract<AppLiveServerMessage, { type: "ready" }>> = {},
): Extract<AppLiveServerMessage, { type: "ready" }> => ({
  type: "ready",
  protocolVersion: 1,
  serverEpoch: "epoch-one",
  connectionId: "connection-one",
  currentCursor: 4,
  heartbeatIntervalMs: 5_000,
  resume,
  ...overrides,
});

const currentUserScope: AppLiveScope = { kind: "current-user" };
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

function createHarness(input?: {
  onAuthenticationRequired?: (reason: string) => void;
  onResync?: (
    scopes: AppLiveScope[],
    reason: AppLiveResyncReason,
  ) => Promise<void> | void;
  storage?: MemoryStorage;
}) {
  const sockets: FakeSocket[] = [];
  const events: AppLiveServerMessage[] = [];
  const recoveries: Array<{
    reason: AppLiveResyncReason;
    scopes: AppLiveScope[];
  }> = [];
  const storage = input?.storage ?? new MemoryStorage();
  const client = new AppLiveClient({
    client: {
      id: "client-one",
      name: "Test client",
      version: "1",
      controlCapabilities: [
        "notify",
        "focus-project",
        "focus-surface",
        "show-interaction",
      ],
    },
    onAuthenticationRequired: input?.onAuthenticationRequired,
    onEvent: (event) => events.push(event),
    onResync: async (scopes, reason) => {
      recoveries.push({ scopes, reason });
      await input?.onResync?.(scopes, reason);
    },
    random: () => 0.5,
    storage,
    storageKey: "live-resume",
    url: "ws://cantrip.test/api/live",
    webSocketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
  });
  return { client, events, recoveries, sockets, storage };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("application live client", () => {
  it("builds local, HTTP, and HTTPS WebSocket URLs", () => {
    expect(appLiveWebSocketUrl("", "http://127.0.0.1:5173")).toBe(
      "ws://127.0.0.1:5173/api/live",
    );
    expect(
      appLiveWebSocketUrl("http://server.example", "https://app.example"),
    ).toBe("ws://server.example/api/live");
    expect(
      appLiveWebSocketUrl("https://server.example", "http://app.example"),
    ).toBe("wss://server.example/api/live");
  });

  it("takes a snapshot barrier for new scopes and tracks live events", async () => {
    vi.useFakeTimers();
    const { client, events, recoveries, sockets, storage } = createHarness();
    const releaseCurrentUser = client.retainScope(currentUserScope);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: "initialize",
      resume: null,
    });

    socket.receive(ready("not-requested"));
    const subscription = socket.sent.at(-1);
    expect(subscription).toMatchObject({
      type: "subscribe",
      scopes: [currentUserScope],
    });
    if (subscription?.type !== "subscribe") {
      throw new Error("Client did not subscribe.");
    }
    socket.receive({
      type: "subscribed",
      requestId: subscription.requestId,
      scopes: subscription.scopes,
      cursor: 4,
    });
    await settle();
    expect(recoveries).toEqual([
      { scopes: [currentUserScope], reason: "scope-changed" },
    ]);
    expect(client.snapshot()).toMatchObject({
      status: "live",
      lastCursor: 4,
      activeScopeCount: 1,
    });

    const projectScope: AppLiveScope = {
      kind: "project",
      projectId: "project-one",
    };
    const releaseProject = client.retainScope(projectScope);
    const projectSubscription = socket.sent.at(-1);
    expect(projectSubscription).toMatchObject({
      type: "subscribe",
      scopes: [projectScope],
    });
    if (projectSubscription?.type !== "subscribe") {
      throw new Error("Client did not subscribe to the project.");
    }
    socket.receive({
      type: "subscribed",
      requestId: projectSubscription.requestId,
      scopes: projectSubscription.scopes,
      cursor: 4,
    });
    await settle();
    expect(recoveries.at(-1)).toEqual({
      scopes: [projectScope],
      reason: "scope-changed",
    });

    socket.receive({
      type: "event",
      cursor: 5,
      scope: currentUserScope,
      resource: "worker",
      action: "status",
      entityId: "worker-one",
      revision: null,
      payload: { online: true },
      occurredAt: "2026-08-09T12:00:00.000Z",
    });
    socket.receive({
      type: "event",
      cursor: 5,
      scope: currentUserScope,
      resource: "worker",
      action: "status",
      entityId: "worker-one",
      revision: null,
      payload: { online: true },
      occurredAt: "2026-08-09T12:00:00.000Z",
    });
    expect(events).toHaveLength(1);
    expect(JSON.parse(storage.getItem("live-resume")!)).toEqual({
      version: 1,
      serverEpoch: "epoch-one",
      cursor: 5,
    });

    await vi.advanceTimersByTimeAsync(5_000);
    expect(socket.sent.at(-1)).toMatchObject({ type: "ping" });

    releaseProject();
    const unsubscribe = socket.sent.at(-1);
    expect(unsubscribe).toMatchObject({
      type: "unsubscribe",
      scopes: [projectScope],
    });
    if (unsubscribe?.type !== "unsubscribe") {
      throw new Error("Client did not unsubscribe from the project.");
    }
    socket.receive({
      type: "unsubscribed",
      requestId: unsubscribe.requestId,
      scopes: unsubscribe.scopes,
      cursor: 5,
    });
    expect(client.snapshot().activeScopeCount).toBe(1);
    releaseCurrentUser();
    client.stop();
  });

  it("replays from persisted cursor without an unnecessary snapshot", async () => {
    const storage = new MemoryStorage();
    storage.setItem(
      "live-resume",
      JSON.stringify({ version: 1, serverEpoch: "epoch-one", cursor: 5 }),
    );
    const { client, events, recoveries, sockets } = createHarness({ storage });
    client.retainScope(currentUserScope);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    expect(socket.sent[0]).toMatchObject({
      type: "initialize",
      resume: { serverEpoch: "epoch-one", cursor: 5 },
    });
    socket.receive(ready("replaying", { currentCursor: 8 }));
    const subscription = socket.sent.at(-1);
    if (subscription?.type !== "subscribe") {
      throw new Error("Client did not subscribe for replay.");
    }
    socket.receive({
      type: "subscribed",
      requestId: subscription.requestId,
      scopes: subscription.scopes,
      cursor: 8,
    });
    socket.receive({ type: "pong", nonce: "during-replay", cursor: 8 });
    expect(client.snapshot().lastCursor).toBe(5);
    socket.receive({
      type: "event",
      cursor: 6,
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 2,
      payload: null,
      occurredAt: "2026-08-09T12:00:00.000Z",
    });
    socket.receive({ type: "caught-up", cursor: 8, replayedCount: 1 });
    await settle();
    expect(events).toHaveLength(1);
    expect(recoveries).toEqual([]);
    expect(client.snapshot()).toMatchObject({ status: "live", lastCursor: 8 });
    client.stop();
  });

  it("does not checkpoint a new scope before its snapshot barrier finishes", async () => {
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const { client, sockets, storage } = createHarness({
      onResync: () => recoveryGate,
    });
    client.retainScope(currentUserScope);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(ready("not-requested"));
    const subscription = socket.sent.at(-1);
    if (subscription?.type !== "subscribe") {
      throw new Error("Client did not subscribe before snapshotting.");
    }
    socket.receive({
      type: "subscribed",
      requestId: subscription.requestId,
      scopes: subscription.scopes,
      cursor: 4,
    });
    expect(client.snapshot().lastCursor).toBe(4);
    expect(storage.getItem("live-resume")).toBeNull();
    finishRecovery();
    await settle();
    expect(JSON.parse(storage.getItem("live-resume")!)).toMatchObject({
      cursor: 4,
      serverEpoch: "epoch-one",
    });
    client.stop();
  });

  it("refreshes authoritative state before acknowledging resync", async () => {
    let finishRecovery!: () => void;
    const recoveryGate = new Promise<void>((resolve) => {
      finishRecovery = resolve;
    });
    const storage = new MemoryStorage();
    storage.setItem(
      "live-resume",
      JSON.stringify({ version: 1, serverEpoch: "old-epoch", cursor: 100 }),
    );
    const { client, recoveries, sockets } = createHarness({
      storage,
      onResync: () => recoveryGate,
    });
    client.retainScope(currentUserScope);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(
      ready("resync-required", {
        serverEpoch: "new-epoch",
        currentCursor: 2,
      }),
    );
    const subscription = socket.sent.at(-1);
    if (subscription?.type !== "subscribe") {
      throw new Error("Client did not establish resync scopes.");
    }
    socket.receive({
      type: "subscribed",
      requestId: subscription.requestId,
      scopes: subscription.scopes,
      cursor: 2,
    });
    socket.receive({
      type: "resync-required",
      cursor: 2,
      reason: "server-epoch-changed",
      scopes: [currentUserScope],
    });
    expect(recoveries).toEqual([
      { scopes: [currentUserScope], reason: "server-epoch-changed" },
    ]);
    expect(socket.sent.some((message) => message.type === "resync-ack")).toBe(
      false,
    );

    finishRecovery();
    await settle();
    const acknowledgement = socket.sent.at(-1);
    expect(acknowledgement).toMatchObject({
      type: "resync-ack",
      cursor: 2,
      scopes: [currentUserScope],
    });
    if (acknowledgement?.type !== "resync-ack") {
      throw new Error("Client did not acknowledge resync.");
    }
    socket.receive({
      type: "subscribed",
      requestId: acknowledgement.requestId,
      scopes: acknowledgement.scopes,
      cursor: 2,
    });
    socket.receive({ type: "caught-up", cursor: 2, replayedCount: 0 });
    expect(client.snapshot()).toMatchObject({
      status: "live",
      serverEpoch: "new-epoch",
      lastCursor: 2,
    });
    expect(JSON.parse(storage.getItem("live-resume")!)).toMatchObject({
      serverEpoch: "new-epoch",
      cursor: 2,
    });
    client.stop();
  });

  it("backs off after protocol failure and reconnects on demand", async () => {
    vi.useFakeTimers();
    const { client, sockets } = createHarness();
    client.retainScope(currentUserScope);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive("not-json");
    expect(socket.closeCode).toBe(1002);
    expect(client.snapshot()).toMatchObject({
      status: "waiting-to-reconnect",
      reconnectAttempt: 1,
    });
    await vi.advanceTimersByTimeAsync(500);
    expect(sockets).toHaveLength(2);
    expect(client.snapshot().status).toBe("connecting");
    client.stop();
    await vi.runAllTimersAsync();
    expect(sockets).toHaveLength(2);
  });

  it("stops reconnecting when the server rejects an expired session", async () => {
    vi.useFakeTimers();
    const authenticationRequired = vi.fn();
    const { client, sockets } = createHarness({
      onAuthenticationRequired: authenticationRequired,
    });
    client.start();
    sockets[0]!.open();
    sockets[0]!.close(1008, "Session is no longer active");

    expect(authenticationRequired).toHaveBeenCalledWith(
      "Session is no longer active",
    );
    expect(client.snapshot().status).toBe("stopped");
    await vi.runAllTimersAsync();
    expect(sockets).toHaveLength(1);
  });

  it("applies each non-replayable client control once and repeats only its acknowledgement", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:00.000Z"));
    const { client, sockets } = createHarness();
    let finishHandler!: () => void;
    const handlerGate = new Promise<void>((resolve) => {
      finishHandler = resolve;
    });
    const handler = vi.fn(async () => {
      await handlerGate;
      return { status: "applied" as const };
    });
    client.registerClientControlHandler(handler);
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(ready("not-requested"));
    const request = {
      type: "client-control-request" as const,
      correlationId: "00000000-0000-4000-8000-000000000001",
      issuedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:00:05.000Z",
      command: {
        kind: "focus-project" as const,
        projectId: "project-one",
      },
    };
    socket.receive(request);
    socket.receive(request);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    finishHandler();
    await settle();
    expect(socket.sent.at(-1)).toEqual({
      type: "client-control-ack",
      correlationId: request.correlationId,
      status: "applied",
      detail: null,
    });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      socket.sent.filter(
        (message) =>
          message.type === "client-control-ack" &&
          message.correlationId === request.correlationId,
      ),
    ).toHaveLength(2);

    socket.receive(request);
    await settle();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(
      socket.sent.filter(
        (message) =>
          message.type === "client-control-ack" &&
          message.correlationId === request.correlationId,
      ),
    ).toHaveLength(3);
    client.stop();
  });

  it("declines expired controls and reports unsupported handlers", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-21T12:00:06.000Z"));
    const { client, sockets } = createHarness();
    client.start();
    const socket = sockets[0]!;
    socket.open();
    socket.receive(ready("not-requested"));
    socket.receive({
      type: "client-control-request",
      correlationId: "00000000-0000-4000-8000-000000000002",
      issuedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T12:00:05.000Z",
      command: {
        kind: "notify",
        projectId: "project-one",
        level: "warning",
        title: "Expired",
        message: "This notice must not be applied.",
      },
    });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "client-control-ack",
      status: "expired",
    });

    vi.setSystemTime(new Date("2026-08-21T12:00:10.000Z"));
    socket.receive({
      type: "client-control-request",
      correlationId: "00000000-0000-4000-8000-000000000003",
      issuedAt: "2026-08-21T12:00:10.000Z",
      expiresAt: "2026-08-21T12:00:15.000Z",
      command: {
        kind: "focus-project",
        projectId: "project-one",
      },
    });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "client-control-ack",
      status: "unsupported",
    });
    client.stop();
  });
});
