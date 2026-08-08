import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { CodeWorkbenchBridge } from "../src/code/workbench-bridge.js";

const bridges: CodeWorkbenchBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
});

function openSocket(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url);
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

describe("Cantrip workbench bridge", () => {
  it("authenticates sessions and exchanges dirty-buffer RPC state", async () => {
    const bridge = new CodeWorkbenchBridge();
    bridges.push(bridge);
    await bridge.start();
    const url = bridge.register("session-one", "secret-one");
    const socket = await openSocket(url);

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
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(bridge.connected("session-one")).toBe(true);
    expect(bridge.dirtyEditors("session-one")).toEqual([
      expect.objectContaining({ relativePath: "README.md", dirty: true }),
    ]);

    socket.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
      };
      expect(request.method).toBe("saveAll");
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result: { saved: ["file:///repo/README.md"], failed: [] },
        }),
      );
    });
    await expect(bridge.saveAll("session-one")).resolves.toEqual({
      saved: ["file:///repo/README.md"],
      failed: [],
    });

    const unauthorized = new URL(url);
    unauthorized.searchParams.set("token", "wrong-token");
    await expect(openSocket(unauthorized.toString())).rejects.toThrow(
      "Unexpected server response: 401",
    );
    socket.close();
  });
});
