import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";

import { CodeWorkbenchBridge } from "./workbench-bridge.js";

interface BridgeRequest {
  id: string;
  method: string;
  params: unknown;
  type: "request";
}

const bridges: CodeWorkbenchBridge[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

async function connectedBridge() {
  const bridge = new CodeWorkbenchBridge({ requestTimeoutMs: 250 });
  bridges.push(bridge);
  await bridge.start();
  const url = bridge.register("settings-session", "correct-token", "dark");
  const socket = new WebSocket(url);
  sockets.push(socket);
  const requests: BridgeRequest[] = [];
  const waiters: Array<(request: BridgeRequest) => void> = [];
  socket.on("message", (data) => {
    const request = JSON.parse(data.toString()) as BridgeRequest;
    if (request.method === "setTheme") {
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result: { applied: true },
        }),
      );
      return;
    }
    const waiter = waiters.shift();
    if (waiter) waiter(request);
    else requests.push(request);
  });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });

  return {
    bridge,
    nextRequest: () =>
      requests.shift() ??
      new Promise<BridgeRequest>((resolve) => waiters.push(resolve)),
    socket,
    url,
  };
}

describe("CodeWorkbenchBridge graphical settings", () => {
  it("sends the exact authenticated openSettings request and accepts its acknowledgement", async () => {
    const { bridge, nextRequest, socket } = await connectedBridge();

    const opening = bridge.openSettings("settings-session");
    const request = await nextRequest();
    expect(request).toMatchObject({
      type: "request",
      method: "openSettings",
      params: {},
    });
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result: { opened: true },
      }),
    );

    await expect(opening).resolves.toEqual({ opened: true });
  });

  it("rejects a malformed openSettings acknowledgement", async () => {
    const { bridge, nextRequest, socket } = await connectedBridge();

    const opening = bridge.openSettings("settings-session");
    const request = await nextRequest();
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: true,
        result: { opened: false },
      }),
    );

    await expect(opening).rejects.toThrow();
  });

  it("propagates a workbench openSettings failure", async () => {
    const { bridge, nextRequest, socket } = await connectedBridge();

    const opening = bridge.openSettings("settings-session");
    const request = await nextRequest();
    socket.send(
      JSON.stringify({
        type: "response",
        id: request.id,
        ok: false,
        error: "Settings editor unavailable.",
      }),
    );

    await expect(opening).rejects.toThrow("Settings editor unavailable.");
  });

  it("does not accept a socket without the registered session token", async () => {
    const { bridge, url } = await connectedBridge();
    const unauthorizedUrl = new URL(url);
    unauthorizedUrl.searchParams.set("token", "wrong-token");
    const unauthorized = new WebSocket(unauthorizedUrl);
    sockets.push(unauthorized);

    await expect(
      new Promise<void>((resolve, reject) => {
        unauthorized.once("open", resolve);
        unauthorized.once("error", reject);
      }),
    ).rejects.toThrow("Unexpected server response: 401");
    expect(bridge.connected("settings-session")).toBe(true);
  });
});
