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

    socket.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
      };
      expect(request.method).toBe("prepareAgentTurn");
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result: {
            allowed: true,
            policy: "always",
            dirtyEditors: [],
            saved: ["file:///repo/README.md"],
            failed: [],
            reason: null,
          },
        }),
      );
    });
    await expect(bridge.prepareAgentTurn("session-one")).resolves.toMatchObject(
      {
        sessionId: "session-one",
        bridgeConnected: true,
        allowed: true,
        policy: "always",
      },
    );

    socket.once("message", (data) => {
      const request = JSON.parse(data.toString()) as {
        id: string;
        method: string;
      };
      expect(request.method).toBe("agentTurnState");
      socket.send(
        JSON.stringify({
          type: "response",
          id: request.id,
          ok: true,
          result: { refreshed: ["README.md"], conflicts: [] },
        }),
      );
    });
    await expect(
      bridge.notifyAgentTurn("session-one", "completed", ["README.md"]),
    ).resolves.toEqual({
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
});
