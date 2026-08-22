import {
  appLiveClientMessageSchema,
  appLiveServerMessageSchema,
} from "@cantrip/protocol";
import type {
  AppLiveClientMessage,
  AppLiveScope,
  AppLiveServerMessage,
  ClientControlCapability,
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
  controlCapabilities: ClientControlCapability[] = [],
): AppLiveClientMessage => ({
  type: "initialize",
  protocolVersion: 1,
  client: {
    id: "test-client",
    name: "Cantrip test",
    version: "1",
    controlCapabilities,
  },
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
      ownerId: "owner-one",
      scope: { kind: "project", projectId: "owned-project" },
      resource: "project",
      action: "updated",
      entityId: "owned-project",
      revision: 2,
      payload: null,
    });
    hub.publish({
      ownerId: "owner-one",
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
    expect(hub.stats()).toMatchObject({
      acceptedConnectionCount: 1,
      connectionCount: 1,
      deliveredEventCount: 1,
      heartbeatPongCount: 1,
      protocolViolationCount: 1,
      publicationCount: 2,
    });
    hub.close();
  });

  it("replays matching retained events after a same-epoch cursor", async () => {
    const hub = new AppLiveHub({ epoch: "epoch-replay" });
    hub.publish({
      ownerId: "owner-one",
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 1,
      payload: { theme: "dark" },
    });
    hub.publish({
      ownerId: "owner-one",
      scope: { kind: "project", projectId: "project-two" },
      resource: "project",
      action: "updated",
      entityId: "project-two",
      revision: 1,
      payload: null,
    });
    hub.publish({
      ownerId: "owner-one",
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
    expect(hub.stats()).toMatchObject({
      deliveredEventCount: 2,
      replaySessionCount: 1,
      replayedEventCount: 2,
      resumeAttemptCount: 1,
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
        ownerId: "owner-one",
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
      ownerId: "owner-one",
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 4,
      payload: null,
    });
    expect(socket.sent.at(-1)).toMatchObject({ type: "event", cursor: 4 });
    expect(hub.stats()).toMatchObject({
      deliveredEventCount: 1,
      replaySessionCount: 1,
      resyncRequiredCount: 1,
      resumeAttemptCount: 1,
    });
    hub.close();
  });

  it("bounds retained replay events by encoded bytes", async () => {
    const hub = new AppLiveHub({
      epoch: "epoch-byte-expiry",
      maxReplayBytes: 1,
    });
    hub.publish({
      ownerId: "owner-one",
      scope: currentUserScope,
      resource: "settings",
      action: "updated",
      entityId: null,
      revision: 1,
      payload: { body: "large enough to exceed one byte" },
    });
    expect(hub.stats().replayEventCount).toBe(0);

    const socket = new FakeSocket();
    hub.attach(socket, {
      ownerId: "owner-one",
      authorizeScope: () => true,
    });
    socket.receive(initialize({ serverEpoch: "epoch-byte-expiry", cursor: 0 }));
    await settle();
    expect(socket.sent[0]).toMatchObject({
      type: "ready",
      resume: "resync-required",
    });
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
    expect(hub.stats().protocolViolationCount).toBe(5);

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
      ownerId: "owner-one",
      scope: currentUserScope,
      resource: "settings",
      action: "invalidated",
      entityId: null,
      revision: null,
      payload: null,
    });
    expect(socket.closeCode).toBe(1013);
    expect(socket.closeReason).toContain("resync");
    expect(hub.stats()).toMatchObject({
      connectionCount: 0,
      queuePressureCount: 1,
      slowConsumerClosureCount: 1,
    });
    hub.close();
  });

  it("isolates simultaneous clients by authorized subscription scope", async () => {
    const hub = new AppLiveHub({ epoch: "multi-client" });
    const first = new FakeSocket();
    const second = new FakeSocket();
    for (const [socket, projectId] of [
      [first, "project-one"],
      [second, "project-two"],
    ] as const) {
      hub.attach(socket, {
        ownerId: projectId,
        authorizeScope: (scope) =>
          scope.kind === "current-user" ||
          (scope.kind === "project" && scope.projectId === projectId),
      });
      socket.receive(initialize());
      socket.receive({
        type: "subscribe",
        requestId: `subscribe-${projectId}`,
        scopes: [currentUserScope, { kind: "project", projectId }],
      });
    }
    await settle();

    for (const projectId of ["project-one", "project-two"]) {
      hub.publish({
        ownerId: projectId,
        scope: { kind: "project", projectId },
        resource: "project",
        action: "updated",
        entityId: projectId,
        revision: null,
        payload: null,
      });
      hub.publish({
        ownerId: projectId,
        scope: currentUserScope,
        resource: "settings",
        action: "updated",
        entityId: null,
        revision: null,
        payload: null,
      });
    }

    expect(first.sent.filter(({ type }) => type === "event")).toEqual([
      expect.objectContaining({
        scope: { kind: "project", projectId: "project-one" },
      }),
      expect.objectContaining({ scope: currentUserScope }),
    ]);
    expect(second.sent.filter(({ type }) => type === "event")).toEqual([
      expect.objectContaining({
        scope: { kind: "project", projectId: "project-two" },
      }),
      expect.objectContaining({ scope: currentUserScope }),
    ]);
    expect(hub.stats()).toMatchObject({
      acceptedConnectionCount: 2,
      connectionCount: 2,
      deliveredEventCount: 4,
    });
    hub.close();
  });

  it("dispatches one-shot client controls only to capable project-active clients", async () => {
    const hub = new AppLiveHub({ epoch: "client-control" });
    const inactive = new FakeSocket();
    const active = new FakeSocket();
    for (const socket of [inactive, active]) {
      hub.attach(socket, {
        ownerId: "owner-one",
        authorizeScope: () => true,
      });
      socket.receive(initialize(null, ["notify"]));
    }
    inactive.receive({
      type: "subscribe",
      requestId: "inactive-scope",
      scopes: [currentUserScope],
    });
    active.receive({
      type: "subscribe",
      requestId: "active-scope",
      scopes: [{ kind: "project", projectId: "project-one" }],
    });
    await settle();

    const pending = hub.requestClientControl("owner-one", {
      kind: "notify",
      projectId: "project-one",
      level: "info",
      title: "Build complete",
      message: "The focused validation passed.",
    });
    await settle();
    expect(
      inactive.sent.some(({ type }) => type === "client-control-request"),
    ).toBe(false);
    const request = active.sent.find(
      ({ type }) => type === "client-control-request",
    );
    expect(request).toMatchObject({
      type: "client-control-request",
      command: { kind: "notify", projectId: "project-one" },
    });
    if (request?.type !== "client-control-request") {
      throw new Error("Active client did not receive the control request.");
    }
    expect(hub.stats()).toMatchObject({
      currentCursor: 0,
      publicationCount: 0,
      replayEventCount: 0,
    });
    active.receive({
      type: "client-control-ack",
      correlationId: request.correlationId,
      status: "applied",
      detail: null,
    });
    await expect(pending).resolves.toEqual({
      correlationId: request.correlationId,
      status: "applied",
    });
    hub.close();
  });

  it("routes exact Run terminal materialization identities through the active project client", async () => {
    const hub = new AppLiveHub({ epoch: "run-terminal-control" });
    const socket = new FakeSocket();
    hub.attach(socket, { ownerId: "owner-one", authorizeScope: () => true });
    socket.receive(initialize(null, ["materialize-run-terminal"]));
    socket.receive({
      type: "subscribe",
      requestId: "run-project-scope",
      scopes: [{ kind: "project", projectId: "project-one" }],
    });
    await settle();

    const runId = "00000000-0000-4000-8000-000000000011";
    const pending = hub.requestClientControl("owner-one", {
      kind: "materialize-run-terminal",
      projectId: "project-one",
      worktreeId: "worktree-one",
      runId,
      terminalId: runId,
      focus: true,
    });
    await settle();
    const request = socket.sent.find(
      ({ type }) => type === "client-control-request",
    );
    expect(request).toMatchObject({
      type: "client-control-request",
      command: {
        kind: "materialize-run-terminal",
        projectId: "project-one",
        worktreeId: "worktree-one",
        runId,
        terminalId: runId,
        focus: true,
      },
    });
    if (request?.type !== "client-control-request") {
      throw new Error("The Run materialization request was not delivered.");
    }
    socket.receive({
      type: "client-control-ack",
      correlationId: request.correlationId,
      status: "applied",
      detail: null,
    });
    await expect(pending).resolves.toMatchObject({ status: "applied" });
    hub.close();
  });

  it("prefers a compatible client subscribed to the interaction chat", async () => {
    const hub = new AppLiveHub({ epoch: "client-control-chat-target" });
    const projectOnly = new FakeSocket();
    const chatActive = new FakeSocket();
    for (const socket of [projectOnly, chatActive]) {
      hub.attach(socket, { ownerId: "owner-one", authorizeScope: () => true });
      socket.receive(initialize(null, ["show-interaction"]));
      socket.receive({
        type: "subscribe",
        requestId: `scope-${socket === projectOnly ? "project" : "chat"}`,
        scopes:
          socket === projectOnly
            ? [{ kind: "project", projectId: "project-one" }]
            : [
                { kind: "project", projectId: "project-one" },
                { kind: "chat", chatId: "chat-one" },
              ],
      });
    }
    await settle();

    const pending = hub.requestClientControl("owner-one", {
      kind: "show-interaction",
      projectId: "project-one",
      chatId: "chat-one",
      interactionId: "interaction-one",
    });
    await settle();
    expect(
      projectOnly.sent.some(({ type }) => type === "client-control-request"),
    ).toBe(false);
    const request = chatActive.sent.find(
      ({ type }) => type === "client-control-request",
    );
    if (request?.type !== "client-control-request") {
      throw new Error(
        "Chat-active client did not receive the control request.",
      );
    }
    chatActive.receive({
      type: "client-control-ack",
      correlationId: request.correlationId,
      status: "applied",
      detail: null,
    });
    await expect(pending).resolves.toMatchObject({ status: "applied" });
    hub.close();
  });

  it("reports unsupported, unavailable, expired, and disconnected controls", async () => {
    const hub = new AppLiveHub({ epoch: "client-control-errors" });
    await expect(
      hub.requestClientControl("owner-one", {
        kind: "focus-project",
        projectId: "project-one",
      }),
    ).resolves.toMatchObject({ status: "unavailable" });

    const socket = new FakeSocket();
    hub.attach(socket, { ownerId: "owner-one", authorizeScope: () => true });
    socket.receive(initialize());
    socket.receive({
      type: "subscribe",
      requestId: "project-scope",
      scopes: [{ kind: "project", projectId: "project-one" }],
    });
    await settle();
    await expect(
      hub.requestClientControl("owner-one", {
        kind: "focus-project",
        projectId: "project-one",
      }),
    ).resolves.toMatchObject({ status: "unsupported" });

    const capable = new FakeSocket();
    hub.attach(capable, { ownerId: "owner-one", authorizeScope: () => true });
    capable.receive(initialize(null, ["focus-project"]));
    capable.receive({
      type: "subscribe",
      requestId: "capable-project-scope",
      scopes: [{ kind: "project", projectId: "project-one" }],
    });
    await settle();
    const expiring = hub.requestClientControl(
      "owner-one",
      { kind: "focus-project", projectId: "project-one" },
      10,
    );
    await settle();
    await expect(expiring).resolves.toMatchObject({ status: "expired" });

    const disconnecting = hub.requestClientControl("owner-one", {
      kind: "focus-project",
      projectId: "project-one",
    });
    await settle();
    capable.close(1006, "network lost");
    await expect(disconnecting).resolves.toMatchObject({
      status: "unavailable",
    });
    hub.close();
  });

  it("closes revoked sessions and revalidates them before accepting frames", async () => {
    const hub = new AppLiveHub({ epoch: "session-validation" });
    let active = true;
    const first = new FakeSocket();
    hub.attach(first, {
      ownerId: "owner-one",
      sessionId: "session-one",
      authorizeScope: () => true,
      isActive: () => active,
    });
    first.receive(initialize());
    await settle();
    expect(first.closeCode).toBeUndefined();

    active = false;
    first.receive({ type: "ping", nonce: "after-revocation" });
    await settle();
    expect(first.closeCode).toBe(1008);
    expect(first.closeReason).toContain("no longer active");

    const second = new FakeSocket();
    const third = new FakeSocket();
    for (const [socket, sessionId, ownerId] of [
      [second, "session-two", "owner-one"],
      [third, "session-three", "owner-two"],
    ] as const) {
      hub.attach(socket, {
        ownerId,
        sessionId,
        authorizeScope: () => true,
      });
    }
    expect(hub.revokeSession("session-two")).toBe(1);
    expect(second.closeCode).toBe(1008);
    expect(third.closeCode).toBeUndefined();
    expect(hub.revokeOwner("owner-two")).toBe(1);
    expect(third.closeCode).toBe(1008);
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
    expect(hub.stats().heartbeatTimeoutCount).toBe(1);

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
