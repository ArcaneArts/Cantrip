import { randomUUID } from "node:crypto";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";
import { subscribeWorkerLogs } from "../src/logger.js";

const bridges: CodeWorkbenchBridge[] = [];
const subscriptions: Array<() => void> = [];
interface WorkbenchRequest {
  id: string;
  method: string;
  params: Record<string, unknown>;
}

const requestQueues = new WeakMap<WebSocket, WorkbenchRequest[]>();
const requestWaiters = new WeakMap<
  WebSocket,
  (request: WorkbenchRequest) => void
>();

afterEach(async () => {
  for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    requestQueues.set(socket, []);
    socket.on("message", (data) => {
      const request = JSON.parse(data.toString()) as WorkbenchRequest;
      const waiter = requestWaiters.get(socket);
      if (waiter) {
        requestWaiters.delete(socket);
        waiter(request);
      } else {
        requestQueues.get(socket)?.push(request);
      }
    });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function nextRequest(socket: WebSocket): Promise<WorkbenchRequest> {
  const queued = requestQueues.get(socket)?.shift();
  if (queued) return Promise.resolve(queued);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      requestWaiters.delete(socket);
      reject(new Error("Timed out waiting for a workbench request."));
    }, 1_000);
    requestWaiters.set(socket, (request) => {
      clearTimeout(timer);
      resolve(request);
    });
  });
}

function respond(socket: WebSocket, request: WorkbenchRequest, result = {}) {
  socket.send(
    JSON.stringify({
      type: "response",
      id: request.id,
      ok: true,
      result,
    }),
  );
}

function rejectRequest(
  socket: WebSocket,
  request: WorkbenchRequest,
  error: string,
) {
  socket.send(
    JSON.stringify({
      type: "response",
      id: request.id,
      ok: false,
      error,
    }),
  );
}

function waitForClose(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) resolve();
    else socket.once("close", () => resolve());
  });
}

function publishState(
  socket: WebSocket,
  options: {
    activePath?: string;
    dirtyPaths?: string[];
    policy?: "always" | "ask" | "never";
  } = {},
) {
  const dirtyPaths = options.dirtyPaths ?? [];
  socket.send(
    JSON.stringify({
      type: "state",
      dirtyEditors: dirtyPaths.map((relativePath) => ({
        uri: `file:///repo/${relativePath}`,
        relativePath,
        untitled: false,
        dirty: true,
      })),
      activeEditor: options.activePath
        ? {
            uri: `file:///repo/${options.activePath}`,
            relativePath: options.activePath,
            selection: {
              startLine: 0,
              startCharacter: 0,
              endLine: 0,
              endCharacter: 0,
            },
          }
        : null,
      git: null,
      conflicts: [],
      savePolicy: options.policy ?? "always",
      agentStatus: "idle",
    }),
  );
}

describe("Cantrip workbench bridge", () => {
  it("proactively retires only a silent authority and preserves its authenticated session", async () => {
    let sweep: (() => Promise<void>) | null = null;
    const disposeScheduler = vi.fn();
    const bridge = new CodeWorkbenchBridge({
      livenessIntervalMs: 1_000,
      livenessTimeoutMs: 25,
      scheduleLiveness(run, intervalMs) {
        expect(intervalMs).toBe(1_000);
        sweep = run;
        return disposeScheduler;
      },
    });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("live-session", "live-secret");

    const healthy = await openSocket(url);
    respond(healthy, await nextRequest(healthy));
    publishState(healthy, { activePath: "healthy.ts" });
    await vi.waitFor(() =>
      expect(bridge.state("live-session").activeEditor?.relativePath).toBe(
        "healthy.ts",
      ),
    );

    const staleAuthority = await openSocket(url);
    respond(staleAuthority, await nextRequest(staleAuthority));
    expect(bridge.connected("live-session")).toBe(true);
    expect(sweep).not.toBeNull();

    const staleClosed = waitForClose(staleAuthority);
    const firstSweep = sweep!();
    const [healthyPing, stalePing] = await Promise.all([
      nextRequest(healthy),
      nextRequest(staleAuthority),
    ]);
    expect(healthyPing.method).toBe("ping");
    expect(stalePing.method).toBe("ping");

    await sweep!();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(requestQueues.get(healthy)).toEqual([]);
    expect(requestQueues.get(staleAuthority)).toEqual([]);

    rejectRequest(healthy, healthyPing, "Unsupported Cantrip workbench method");
    await firstSweep;
    await staleClosed;

    expect(staleAuthority.readyState).toBe(WebSocket.CLOSED);
    expect(healthy.readyState).toBe(WebSocket.OPEN);
    expect(bridge.connected("live-session")).toBe(true);
    expect(bridge.state("live-session").activeEditor?.relativePath).toBe(
      "healthy.ts",
    );

    const opening = bridge.openFile(
      "live-session",
      "healthy.ts",
      "file:///repo",
    );
    const openRequest = await nextRequest(healthy);
    expect(openRequest).toMatchObject({
      method: "openFile",
      params: { path: "healthy.ts" },
    });
    respond(healthy, openRequest, { relativePath: "healthy.ts" });
    await expect(opening).resolves.toEqual({ relativePath: "healthy.ts" });

    const reconnected = await openSocket(url);
    expect((await nextRequest(reconnected)).method).toBe("setTheme");
    expect(bridge.connected("live-session")).toBe(true);

    await bridge.close();
    expect(disposeScheduler).toHaveBeenCalledOnce();
    healthy.terminate();
    reconnected.terminate();
  });

  it("does not block agent turns for a disconnected clean editor", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    bridge.register("disconnected-session", "disconnected-secret");

    await expect(
      bridge.prepareAgentTurn("disconnected-session"),
    ).resolves.toEqual({
      sessionId: "disconnected-session",
      bridgeConnected: false,
      allowed: true,
      policy: null,
      dirtyEditors: [],
      saved: [],
      failed: [],
      reason: null,
    });
  });

  it("bounds disconnected control waits below the client deadline", async () => {
    const bridge = new CodeWorkbenchBridge({ controlConnectTimeoutMs: 25 });
    bridges.push(bridge);
    await bridge.start();
    bridge.register("bounded-session", "bounded-secret");

    const startedAt = Date.now();
    await expect(
      bridge.setPresentation("bounded-session", "editor"),
    ).rejects.toThrow("not connected");
    expect(Date.now() - startedAt).toBeLessThan(250);
  });

  it("keeps a surface connected when theme delivery stalls and replays the latest theme", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 25 });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("recovering-session", "recovering-secret");
    const stale = await openSocket(url);
    await nextRequest(stale);

    const stalledTheme = nextRequest(stale);
    await expect(
      bridge.setTheme("recovering-session", "high-contrast-light"),
    ).resolves.toBeUndefined();
    expect(await stalledTheme).toMatchObject({
      method: "setTheme",
      params: { appearance: "high-contrast-light" },
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(stale.readyState).toBe(WebSocket.OPEN);
    expect(bridge.connected("recovering-session")).toBe(true);

    const staleClosed = waitForClose(stale);
    stale.close();
    await staleClosed;
    const recovered = await openSocket(url);
    const recoveredTheme = await nextRequest(recovered);
    expect(recoveredTheme).toMatchObject({
      method: "setTheme",
      params: { appearance: "high-contrast-light" },
    });
    respond(recovered, recoveredTheme);
    expect(bridge.connected("recovering-session")).toBe(true);
    recovered.close();
  });

  it("authenticates sessions and exchanges dirty-buffer RPC state", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("session-one", "secret-one");
    const socket = await openSocket(url);
    const initialTheme = await nextRequest(socket);
    expect(initialTheme).toMatchObject({
      method: "setTheme",
      params: { appearance: "dark" },
    });
    respond(socket, initialTheme);

    socket.send(
      JSON.stringify({
        type: "state",
        dirtyEditors: [
          {
            uri: "file:///repo/README.md",
            relativePath: "README.md",
            untitled: false,
            dirty: true,
          },
        ],
        activeEditor: {
          uri: "file:///repo/README.md",
          relativePath: "README.md",
          selection: {
            startLine: 2,
            startCharacter: 1,
            endLine: 2,
            endCharacter: 4,
          },
        },
        git: {
          branch: "main",
          head: "abc123",
          ahead: 1,
          behind: 0,
          staged: 0,
          unstaged: 1,
          untracked: 0,
          conflicts: 0,
        },
        conflicts: [],
        savePolicy: "always",
        agentStatus: "idle",
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.connected("session-one")).toBe(true);
    expect(bridge.dirtyEditors("session-one")).toEqual([
      expect.objectContaining({ relativePath: "README.md", dirty: true }),
    ]);
    expect(bridge.state("session-one")).toMatchObject({
      activeEditor: { relativePath: "README.md" },
      git: { branch: "main", unstaged: 1 },
      savePolicy: "always",
    });

    const nextSaveRequest = nextRequest(socket);
    const save = bridge.saveAll("session-one");
    const saveRequest = await nextSaveRequest;
    expect(saveRequest.method).toBe("saveAll");
    respond(socket, saveRequest, {
      saved: ["file:///repo/README.md"],
      failed: [],
    });
    await expect(save).resolves.toEqual({
      saved: ["file:///repo/README.md"],
      failed: [],
    });

    const nextPrepareRequest = nextRequest(socket);
    const prepare = bridge.prepareAgentTurn("session-one");
    const prepareRequest = await nextPrepareRequest;
    expect(prepareRequest.method).toBe("prepareAgentTurn");
    respond(socket, prepareRequest, {
      allowed: true,
      policy: "always",
      dirtyEditors: [],
      saved: ["file:///repo/README.md"],
      failed: [],
      reason: null,
    });
    await expect(prepare).resolves.toMatchObject({
      sessionId: "session-one",
      bridgeConnected: true,
      allowed: true,
      policy: "always",
    });

    const nextNotificationRequest = nextRequest(socket);
    const notification = bridge.notifyAgentTurn("session-one", "completed", [
      "README.md",
    ]);
    const notificationRequest = await nextNotificationRequest;
    expect(notificationRequest.method).toBe("agentTurnState");
    respond(socket, notificationRequest, {
      refreshed: ["README.md"],
      conflicts: [],
    });
    await expect(notification).resolves.toEqual({
      notifiedSessions: 1,
      refreshed: ["README.md"],
      conflicts: [],
    });

    const unauthorized = new URL(url);
    unauthorized.searchParams.set("token", "wrong-token");
    await expect(openSocket(unauthorized.toString())).rejects.toThrow(
      "Unexpected server response: 401",
    );
    socket.close();
  });

  it("keeps retired bridge upgrades unauthorized while classifying exact teardown at debug", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    const retiredSessionId = randomUUID();
    const retiredToken = `retired-${randomUUID()}`;
    const retiredUrl = bridge.register(retiredSessionId, retiredToken);
    const records: Array<{ context?: unknown; level: string }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    subscriptions.push(unsubscribe);

    bridge.unregister(retiredSessionId);
    await expect(openSocket(retiredUrl)).rejects.toThrow(
      "Unexpected server response: 401",
    );

    const unknownSessionId = randomUUID();
    const unknownUrl = new URL(retiredUrl);
    unknownUrl.pathname = `/sessions/${unknownSessionId}`;
    unknownUrl.searchParams.set("token", "unknown-token");
    await expect(openSocket(unknownUrl.toString())).rejects.toThrow(
      "Unexpected server response: 401",
    );

    const activeSessionId = randomUUID();
    const activeUrl = bridge.register(activeSessionId, "active-token");
    const invalidTokenUrl = new URL(activeUrl);
    invalidTokenUrl.searchParams.set("token", "wrong-token");
    await expect(openSocket(invalidTokenUrl.toString())).rejects.toThrow(
      "Unexpected server response: 401",
    );

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "debug",
          context: expect.objectContaining({
            event: "code.bridge.upgrade-rejected",
            reasonCode: "retired-session",
            sessionId: retiredSessionId,
          }),
        }),
        expect.objectContaining({
          level: "warn",
          context: expect.objectContaining({
            event: "code.bridge.upgrade-rejected",
            reasonCode: "unknown-session",
            sessionId: unknownSessionId,
          }),
        }),
        expect.objectContaining({
          level: "warn",
          context: expect.objectContaining({
            event: "code.bridge.upgrade-rejected",
            reasonCode: "invalid-token",
            sessionId: activeSessionId,
          }),
        }),
      ]),
    );
    expect(JSON.stringify(records)).not.toContain(retiredToken);
  });

  it("bounds retired session tombstones and clears them on exact registration reuse", async () => {
    const bridge = new CodeWorkbenchBridge({
      retiredSessionLimit: 2,
      retiredSessionTtlMs: 1_000,
    });
    bridges.push(bridge);
    await bridge.start();
    const records: Array<{ context?: unknown; level: string }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    subscriptions.push(unsubscribe);
    const retired = Array.from({ length: 3 }, () => {
      const sessionId = randomUUID();
      const url = bridge.register(sessionId, randomUUID());
      bridge.unregister(sessionId);
      return { sessionId, url };
    });

    await expect(openSocket(retired[0]!.url)).rejects.toThrow(
      "Unexpected server response: 401",
    );
    await expect(openSocket(retired[2]!.url)).rejects.toThrow(
      "Unexpected server response: 401",
    );

    const reusedSessionId = retired[2]!.sessionId;
    const replacementUrl = bridge.register(reusedSessionId, "replacement");
    await expect(openSocket(retired[2]!.url)).rejects.toThrow(
      "Unexpected server response: 401",
    );
    const replacement = await openSocket(replacementUrl);
    replacement.close();

    expect(records).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "warn",
          context: expect.objectContaining({
            reasonCode: "unknown-session",
            sessionId: retired[0]!.sessionId,
          }),
        }),
        expect.objectContaining({
          level: "debug",
          context: expect.objectContaining({
            reasonCode: "retired-session",
            sessionId: retired[2]!.sessionId,
          }),
        }),
        expect.objectContaining({
          level: "warn",
          context: expect.objectContaining({
            reasonCode: "invalid-token",
            sessionId: reusedSessionId,
          }),
        }),
      ]),
    );
  });

  it("expires retired session tombstones without changing rejection", async () => {
    const bridge = new CodeWorkbenchBridge({ retiredSessionTtlMs: 10 });
    bridges.push(bridge);
    await bridge.start();
    const records: Array<{ context?: unknown; level: string }> = [];
    const unsubscribe = subscribeWorkerLogs((record) => records.push(record));
    subscriptions.push(unsubscribe);
    let now = Date.now();
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const sessionId = randomUUID();
      const url = bridge.register(sessionId, randomUUID());
      bridge.unregister(sessionId);
      now += 11;

      await expect(openSocket(url)).rejects.toThrow(
        "Unexpected server response: 401",
      );
      expect(records).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            level: "warn",
            context: expect.objectContaining({
              reasonCode: "unknown-session",
              sessionId,
            }),
          }),
        ]),
      );
    } finally {
      clock.mockRestore();
    }
  });

  it("keeps every workbench surface connected and reapplies themes", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register(
      "shared-session",
      "shared-secret",
      "high-contrast-dark",
    );
    const first = await openSocket(url);
    const firstInitialTheme = await nextRequest(first);
    expect(firstInitialTheme).toMatchObject({
      method: "setTheme",
      params: { appearance: "high-contrast-dark" },
    });
    respond(first, firstInitialTheme);

    const second = await openSocket(url);
    const secondInitialTheme = await nextRequest(second);
    expect(secondInitialTheme).toMatchObject({
      method: "setTheme",
      params: { appearance: "high-contrast-dark" },
    });
    respond(second, secondInitialTheme);

    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(second.readyState).toBe(WebSocket.OPEN);
    expect(bridge.connected("shared-session")).toBe(true);

    const firstUpdateRequest = nextRequest(first);
    const secondUpdateRequest = nextRequest(second);
    const update = bridge.setTheme("shared-session", "light");
    const [firstUpdate, secondUpdate] = await Promise.all([
      firstUpdateRequest,
      secondUpdateRequest,
    ]);
    expect(firstUpdate).toMatchObject({
      method: "setTheme",
      params: { appearance: "light" },
    });
    expect(secondUpdate).toMatchObject({
      method: "setTheme",
      params: { appearance: "light" },
    });
    respond(first, firstUpdate);
    respond(second, secondUpdate);
    await update;

    second.close();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(bridge.connected("shared-session")).toBe(true);

    const finalUpdateRequest = nextRequest(first);
    const finalUpdate = bridge.setTheme("shared-session", "dark");
    const finalRequest = await finalUpdateRequest;
    expect(finalRequest).toMatchObject({
      method: "setTheme",
      params: { appearance: "dark" },
    });
    respond(first, finalRequest);
    await finalUpdate;
    first.close();
  });

  it("uses the latest socket for RPC and ignores superseded responses", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 250 });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("owned-session", "owned-secret");
    const first = await openSocket(url);
    respond(first, await nextRequest(first));
    const second = await openSocket(url);
    respond(second, await nextRequest(second));

    const pendingOpen = bridge.openFile(
      "owned-session",
      "second.ts",
      "file:///repo",
    );
    const superseded = expect(pendingOpen).rejects.toThrow("superseded");
    const secondRequest = await nextRequest(second);
    expect(secondRequest.method).toBe("openFile");

    const third = await openSocket(url);
    respond(third, await nextRequest(third));
    respond(second, secondRequest, { relativePath: "second.ts" });
    await superseded;

    const currentOpen = bridge.openFile(
      "owned-session",
      "current.ts",
      "file:///repo",
    );
    const thirdRequest = await nextRequest(third);
    expect(thirdRequest).toMatchObject({
      method: "openFile",
      params: { path: "current.ts" },
    });
    respond(third, thirdRequest, { relativePath: "current.ts" });
    await expect(currentOpen).resolves.toEqual({ relativePath: "current.ts" });

    first.close();
    second.close();
    third.close();
  });

  it("cancels only the exact pending RPC without retiring its socket", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 5_000 });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("cancel-session", "cancel-secret");
    const socket = await openSocket(url);
    respond(socket, await nextRequest(socket));
    const controller = new AbortController();

    const pending = bridge.openFile(
      "cancel-session",
      "cancelled.ts",
      "file:///repo",
      controller.signal,
    );
    expect((await nextRequest(socket)).method).toBe("openFile");
    controller.abort(new Error("Cantrip Code operation was superseded."));

    await expect(
      Promise.race([
        pending,
        new Promise<never>((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("Bridge cancellation was not prompt.")),
            250,
          ),
        ),
      ]),
    ).rejects.toThrow("superseded");
    expect(socket.readyState).toBe(WebSocket.OPEN);

    const current = bridge.openFile(
      "cancel-session",
      "current.ts",
      "file:///repo",
    );
    const currentRequest = await nextRequest(socket);
    respond(socket, currentRequest, { relativePath: "current.ts" });
    await expect(current).resolves.toEqual({ relativePath: "current.ts" });
    socket.close();
  });

  it("unions per-socket dirty state while only the authority owns workbench state", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("state-session", "state-secret");
    const first = await openSocket(url);
    respond(first, await nextRequest(first));
    publishState(first, { activePath: "first.ts", dirtyPaths: ["first.ts"] });
    await vi.waitFor(() =>
      expect(bridge.state("state-session").activeEditor?.relativePath).toBe(
        "first.ts",
      ),
    );

    const second = await openSocket(url);
    respond(second, await nextRequest(second));
    expect(bridge.state("state-session")).toEqual({
      activeEditor: null,
      git: null,
      conflicts: [],
      savePolicy: "always",
      agentStatus: "idle",
    });
    publishState(second, {
      activePath: "second.ts",
      dirtyPaths: ["second.ts", "shared.ts"],
      policy: "ask",
    });
    publishState(first, {
      activePath: "stale.ts",
      dirtyPaths: ["first.ts", "shared.ts"],
      policy: "never",
    });
    await vi.waitFor(() =>
      expect(
        bridge
          .dirtyEditors("state-session")
          .map((editor) => editor.relativePath),
      ).toEqual(["first.ts", "second.ts", "shared.ts"]),
    );
    expect(bridge.state("state-session")).toMatchObject({
      activeEditor: { relativePath: "second.ts" },
      savePolicy: "ask",
    });

    const promoted = new Promise<void>((resolve) =>
      second.once("close", () => resolve()),
    );
    second.close();
    await promoted;
    await vi.waitFor(() =>
      expect(bridge.state("state-session")).toMatchObject({
        activeEditor: { relativePath: "stale.ts" },
        savePolicy: "never",
      }),
    );
    expect(
      bridge.dirtyEditors("state-session").map((editor) => editor.relativePath),
    ).toEqual(["first.ts", "second.ts", "shared.ts"]);
    first.close();
  });

  it("coordinates every dirty surface and fails safely when one stops responding", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 25 });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("dirty-session", "dirty-secret");
    const first = await openSocket(url);
    respond(first, await nextRequest(first));
    const second = await openSocket(url);
    respond(second, await nextRequest(second));
    publishState(first, { dirtyPaths: ["first.ts"] });
    publishState(second, { dirtyPaths: ["second.ts"] });
    await vi.waitFor(() =>
      expect(
        bridge
          .dirtyEditors("dirty-session")
          .map((editor) => editor.relativePath),
      ).toEqual(["first.ts", "second.ts"]),
    );

    const firstPrepareRequest = nextRequest(first);
    const secondPrepareRequest = nextRequest(second);
    const prepare = bridge.prepareAgentTurn("dirty-session");
    const [firstPrepare, secondPrepare] = await Promise.all([
      firstPrepareRequest,
      secondPrepareRequest,
    ]);
    expect(firstPrepare.method).toBe("prepareAgentTurn");
    expect(secondPrepare.method).toBe("prepareAgentTurn");
    respond(first, firstPrepare, {
      allowed: true,
      policy: "always",
      dirtyEditors: [],
      saved: ["file:///repo/first.ts"],
      failed: [],
      reason: null,
    });
    respond(second, secondPrepare, {
      allowed: false,
      policy: "ask",
      dirtyEditors: [
        {
          uri: "file:///repo/second.ts",
          relativePath: "second.ts",
          untitled: false,
          dirty: true,
        },
      ],
      saved: [],
      failed: [],
      reason: "Save second.ts before continuing.",
    });
    await expect(prepare).resolves.toMatchObject({
      allowed: false,
      policy: "ask",
      dirtyEditors: [expect.objectContaining({ relativePath: "second.ts" })],
      saved: ["file:///repo/first.ts"],
      reason: "Save second.ts before continuing.",
    });

    const firstSaveRequest = nextRequest(first);
    const secondSaveRequest = nextRequest(second);
    const save = bridge.saveAll("dirty-session");
    const [firstSave, secondSave] = await Promise.all([
      firstSaveRequest,
      secondSaveRequest,
    ]);
    expect(firstSave.method).toBe("saveAll");
    expect(secondSave.method).toBe("saveAll");
    respond(first, firstSave, {
      saved: ["file:///repo/first.ts"],
      failed: [],
    });
    await expect(save).resolves.toEqual({
      saved: ["file:///repo/first.ts"],
      failed: [
        {
          uri: "file:///repo/second.ts",
          message: "Cantrip workbench saveAll request timed out.",
        },
      ],
    });
    expect(secondSave.method).toBe("saveAll");
    expect(bridge.connected("dirty-session")).toBe(true);

    const unresolvedRequest = nextRequest(first);
    const unresolvedPrepare = bridge.prepareAgentTurn("dirty-session");
    const firstUnresolved = await unresolvedRequest;
    respond(first, firstUnresolved, {
      allowed: true,
      policy: "always",
      dirtyEditors: [],
      saved: ["file:///repo/first.ts"],
      failed: [],
      reason: null,
    });
    await expect(unresolvedPrepare).resolves.toMatchObject({
      allowed: false,
      dirtyEditors: [expect.objectContaining({ relativePath: "second.ts" })],
      failed: [
        {
          uri: "file:///repo/second.ts",
          message:
            "Cantrip workbench bridge disconnected before this unsaved editor was resolved.",
        },
      ],
      reason:
        "A disconnected Cantrip workbench still has unresolved unsaved editors.",
    });

    const third = await openSocket(url);
    respond(third, await nextRequest(third));
    publishState(third, { dirtyPaths: ["third.ts"] });
    await vi.waitFor(() =>
      expect(
        bridge
          .dirtyEditors("dirty-session")
          .map((editor) => editor.relativePath),
      ).toEqual(["first.ts", "third.ts"]),
    );
    const firstRetryRequest = nextRequest(first);
    const thirdPrepareRequest = nextRequest(third);
    const blockedPrepare = bridge.prepareAgentTurn("dirty-session");
    const [firstRetry, thirdPrepare] = await Promise.all([
      firstRetryRequest,
      thirdPrepareRequest,
    ]);
    respond(first, firstRetry, {
      allowed: true,
      policy: "always",
      dirtyEditors: [],
      saved: ["file:///repo/first.ts"],
      failed: [],
      reason: null,
    });
    expect(thirdPrepare.method).toBe("prepareAgentTurn");
    await expect(blockedPrepare).resolves.toMatchObject({
      allowed: false,
      dirtyEditors: [expect.objectContaining({ relativePath: "third.ts" })],
      failed: [
        {
          uri: "file:///repo/third.ts",
          message: "Cantrip workbench prepareAgentTurn request timed out.",
        },
      ],
      reason: expect.stringContaining(
        "A Cantrip workbench with unsaved editors did not respond.",
      ),
    });
    first.close();
  });
});
