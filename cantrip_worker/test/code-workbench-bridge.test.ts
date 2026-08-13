import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";

const bridges: CodeWorkbenchBridge[] = [];
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

describe("Cantrip workbench bridge", () => {
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

  it("retires an unresponsive surface and replays its theme on reconnect", async () => {
    const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 25 });
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("recovering-session", "recovering-secret");
    const stale = await openSocket(url);
    await nextRequest(stale);

    await expect(
      bridge.setTheme("recovering-session", "high-contrast-light"),
    ).resolves.toBeUndefined();
    await new Promise<void>((resolve) => {
      if (stale.readyState === WebSocket.CLOSED) resolve();
      else stale.once("close", () => resolve());
    });
    expect(bridge.connected("recovering-session")).toBe(false);

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
});
