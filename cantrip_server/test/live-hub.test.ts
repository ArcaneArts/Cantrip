import {
  appLiveClientMessageSchema,
  appLiveServerMessageSchema,
} from "@cantrip/protocol";
import type {
  AppLiveClientMessage,
  AppLiveScope,
  AppLiveServerMessage,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AppLiveHub, type AppLiveSocket } from "../src/live/hub.js";

class FakeSocket implements AppLiveSocket {
  bufferedAmount = 0;
  closeCode: number | undefined;
  closeReason: string | undefined;
  readyState = 1;
  readonly sent: AppLiveServerMessage[] = [];
  readonly #closeListeners: Array<() => void> = [];
  readonly #errorListeners: Array<(error: Error) => void> = [];
  readonly #messageListeners: Array<
    (data: unknown, isBinary?: boolean) => void
  > = [];

  close(code?: number, reason?: string): void {
    if (this.readyState === 3) return;
    this.closeCode = code;
    this.closeReason = reason;
    this.readyState = 3;
    for (const listener of this.#closeListeners) listener();
  }

  on(event: "close", listener: () => void): void;
  on(event: "error", listener: (error: Error) => void): void;
  on(
    event: "message",
    listener: (data: unknown, isBinary?: boolean) => void,
  ): void;
  on(
    event: "close" | "error" | "message",
    listener:
      | (() => void)
      | ((error: Error) => void)
      | ((data: unknown, isBinary?: boolean) => void),
  ): void {
    switch (event) {
      case "close":
        this.#closeListeners.push(listener as () => void);
        break;
      case "error":
        this.#errorListeners.push(listener as (error: Error) => void);
        break;
      case "message":
        this.#messageListeners.push(
          listener as (data: unknown, isBinary?: boolean) => void,
        );
        break;
    }
  }

  send(data: string): void {
    this.sent.push(appLiveServerMessageSchema.parse(JSON.parse(data)));
  }

  receive(message: AppLiveClientMessage | string, isBinary = false): void {
    const data =
      typeof message === "string"
        ? message
        : JSON.stringify(appLiveClientMessageSchema.parse(message));
    for (const listener of this.#messageListeners) listener(data, isBinary);
  }
}

const initialize = (
  resume: { serverEpoch: string; cursor: number } | null = null,
): AppLiveClientMessage => ({
  type: "initialize",
  protocolVersion: 1,
  client: { id: "test-client", name: "Cantrip test", version: "1" },
  resume,
});

const currentUserScope: AppLiveScope = { kind: "current-user" };

const settle = async () => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

afterEach(() => {
  vi.useRealTimers();
});

describe("AppLiveHub", () => {
  it("initializes, authorizes subscriptions, publishes, and handles duplicate requests", async () => {
    const hub = new AppLiveHub({ epoch: "epoch-one" });
    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: (scope) =>
        scope.kind === "current-user" ||
        (scope.kind === "project" && scope.projectId === "owned-project"),
    });

    socket.receive({
      type: "subscribe",
      requestId: "too-early",
      scopes: [currentUserScope],
    });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      code: "not-initialized",
      requestId: "too-early",
    });

    socket.receive(initialize());
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "ready",
      serverEpoch: "epoch-one",
      currentCursor: 0,
      resume: "not-requested",
    });

    const subscribe: AppLiveClientMessage = {
      type: "subscribe",
      requestId: "subscribe-one",
      scopes: [
        currentUserScope,
        { kind: "project", projectId: "owned-project" },
      ],
    };
    socket.receive(subscribe);
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "subscribed",
      requestId: "subscribe-one",
    });

    socket.receive(subscribe);
    await settle();
    expect(
      socket.sent.filter(
        (message) =>
          message.type === "subscribed" &&
          message.requestId === "subscribe-one",
      ),
    ).toHaveLength(2);

    hub.publish({
      scope: { kind: "project", projectId: "owned-project" },
      resource: "project",
      action: "updated",
      entityId: "owned-project",
      revision: 2,
      payload: null,
    });
    hub.publish({
      scope: { kind: "project", projectId: "other-project" },
      resource: "project",
      action: "updated",
      entityId: "other-project",
      revision: 1,
      payload: null,
    });
    expect(socket.sent.filter((message) => message.type === "event")).toEqual([
      expect.objectContaining({
        cursor: 1,
        scope: { kind: "project", projectId: "owned-project" },
      }),
    ]);

    socket.receive({ type: "ping", nonce: "heartbeat-one" });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "pong",
      nonce: "heartbeat-one",
      cursor: 2,
    });

    socket.receive({
      type: "subscribe",
      requestId: "subscribe-denied",
      scopes: [{ kind: "project", projectId: "other-project" }],
    });
    await settle();
    expect(socket.sent.at(-1)).toMatchObject({
      type: "error",
      requestId: "subscribe-denied",
      code: "unauthorized-scope",
    });
    hub.close();
  });

  it("replays matching retained events after a same-epoch cursor", async () => {
    const hub = new AppLiveHub({ epoch: "epoch-replay" });
    hub.publish({
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 1,
      payload: { theme: "dark" },
    });
    hub.publish({
      scope: { kind: "project", projectId: "project-two" },
      resource: "project",
      action: "updated",
      entityId: "project-two",
      revision: 1,
      payload: null,
    });
    hub.publish({
      scope: currentUserScope,
      resource: "worker",
      action: "status",
      entityId: "worker-one",
      revision: null,
      payload: { online: true },
    });

    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    socket.receive(initialize({ serverEpoch: "epoch-replay", cursor: 0 }));
    socket.receive({
      type: "subscribe",
      requestId: "resume-subscription",
      scopes: [currentUserScope],
    });
    await settle();

    expect(socket.sent[0]).toMatchObject({
      type: "ready",
      resume: "replaying",
      currentCursor: 3,
    });
    expect(socket.sent.filter((message) => message.type === "event")).toEqual([
      expect.objectContaining({ cursor: 1, resource: "settings" }),
      expect.objectContaining({ cursor: 3, resource: "worker" }),
    ]);
    expect(socket.sent.at(-1)).toEqual({
      type: "caught-up",
      cursor: 3,
      replayedCount: 2,
    });
    hub.close();
  });

  it("requires resync for expired cursors and recovers after acknowledgement", async () => {
    const hub = new AppLiveHub({
      epoch: "epoch-expiry",
      maxReplayEvents: 2,
    });
    for (let index = 1; index <= 3; index += 1) {
      hub.publish({
        scope: currentUserScope,
        resource: "settings",
        action: "updated",
        entityId: null,
        revision: index,
        payload: { index },
      });
    }

    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    socket.receive(initialize({ serverEpoch: "epoch-expiry", cursor: 0 }));
    socket.receive({
      type: "subscribe",
      requestId: "expired-subscription",
      scopes: [currentUserScope],
    });
    await settle();
    expect(socket.sent[0]).toMatchObject({
      type: "ready",
      resume: "resync-required",
    });
    expect(socket.sent.at(-1)).toEqual({
      type: "resync-required",
      cursor: 3,
      reason: "cursor-expired",
      scopes: [currentUserScope],
    });

    socket.receive({
      type: "resync-ack",
      requestId: "resync-one",
      cursor: 3,
      scopes: [currentUserScope],
    });
    await settle();
    expect(socket.sent.at(-1)).toEqual({
      type: "caught-up",
      cursor: 3,
      replayedCount: 0,
    });
    hub.publish({
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 4,
      payload: null,
    });
    expect(socket.sent.at(-1)).toMatchObject({ type: "event", cursor: 4 });
    hub.close();
  });

  it("reports an epoch change before requiring an authoritative resync", async () => {
    const hub = new AppLiveHub({ epoch: "new-epoch" });
    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    socket.receive(initialize({ serverEpoch: "old-epoch", cursor: 0 }));
    socket.receive({
      type: "subscribe",
      requestId: "epoch-subscription",
      scopes: [currentUserScope],
    });
    await settle();
    expect(socket.sent).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "ready",
          resume: "resync-required",
        }),
        expect.objectContaining({
          type: "resync-required",
          reason: "server-epoch-changed",
        }),
      ]),
    );
    hub.close();
  });

  it("bounds malformed and oversized input", async () => {
    const hub = new AppLiveHub({ maxInboundBytes: 256 });
    const malformedSocket = new FakeSocket();
    hub.attach(malformedSocket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });

    malformedSocket.receive("not-json");
    malformedSocket.receive(
      JSON.stringify({ type: "initialize", protocolVersion: 99 }),
    );
    malformedSocket.receive("binary", true);
    await settle();
    expect(
      malformedSocket.sent
        .filter((message) => message.type === "error")
        .map((message) => (message.type === "error" ? message.code : null)),
    ).toEqual(["invalid-message", "unsupported-version", "invalid-message"]);

    malformedSocket.receive("still-not-json");
    malformedSocket.receive("again-not-json");
    await settle();
    expect(malformedSocket.closeCode).toBe(1008);

    const oversizedSocket = new FakeSocket();
    hub.attach(oversizedSocket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    oversizedSocket.receive(JSON.stringify({ oversized: "x".repeat(300) }));
    await settle();
    expect(oversizedSocket.sent.at(-1)).toMatchObject({
      type: "error",
      code: "payload-too-large",
    });
    expect(oversizedSocket.closeCode).toBe(1009);
    hub.close();
  });

  it("closes slow consumers instead of growing an unbounded queue", async () => {
    const hub = new AppLiveHub({ maxBufferedBytes: 512 });
    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    socket.receive(initialize());
    socket.receive({
      type: "subscribe",
      requestId: "slow-subscription",
      scopes: [currentUserScope],
    });
    await settle();

    socket.bufferedAmount = 500;
    hub.publish({
      scope: currentUserScope,
      resource: "settings",
      action: "invalidated",
      entityId: null,
      revision: null,
      payload: null,
    });
    expect(socket.closeCode).toBe(1013);
    expect(socket.closeReason).toContain("resync");
    expect(hub.stats().connectionCount).toBe(0);
    hub.close();
  });

  it("times out missing heartbeats and cleans up remaining sockets on shutdown", async () => {
    vi.useFakeTimers();
    let now = 0;
    const hub = new AppLiveHub({
      heartbeatIntervalMs: 5_000,
      now: () => now,
    });
    const staleSocket = new FakeSocket();
    hub.attach(staleSocket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    now = 15_001;
    await vi.advanceTimersByTimeAsync(5_000);
    expect(staleSocket.closeCode).toBe(1001);
    expect(staleSocket.closeReason).toContain("heartbeat");

    const shutdownSocket = new FakeSocket();
    hub.attach(shutdownSocket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    hub.close();
    expect(shutdownSocket.closeCode).toBe(1001);
    expect(shutdownSocket.closeReason).toContain("shutting down");
    expect(hub.stats().connectionCount).toBe(0);
  });
});
