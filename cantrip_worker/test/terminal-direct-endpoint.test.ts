import { randomUUID } from "node:crypto";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";

import { TerminalDirectEndpointManager } from "../src/terminal-direct-endpoint.js";
import type { TerminalManager } from "../src/terminal-manager.js";

const managers: TerminalDirectEndpointManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.close();
});

describe("TerminalDirectEndpointManager", () => {
  it("preserves the terminal WebSocket message contract", async () => {
    const input = vi.fn();
    const resize = vi.fn();
    const detach = vi.fn(() => ({ status: "detached" as const }));
    const terminal = {
      attachExisting: vi.fn(
        (_terminalId, _attachmentId, _cols, _rows, emit) => {
          emit({ type: "terminal.ready" });
          emit({ type: "terminal.output", data: "hello" });
          return new Promise(() => undefined);
        },
      ),
      detach,
      input,
      resize,
    } as unknown as TerminalManager;
    const manager = new TerminalDirectEndpointManager(terminal);
    managers.push(manager);
    const capabilityId = randomUUID();
    const target = await manager.prepare(capabilityId, "terminal-1");
    if (target.kind !== "tcp") throw new Error("expected loopback target");
    const socket = new WebSocket(`ws://${target.host}:${target.port}/terminal`);
    const messages: unknown[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages).toEqual([
      { type: "ready" },
      { type: "output", data: "hello" },
    ]);

    socket.send(JSON.stringify({ type: "input", data: "pwd\r" }));
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => {
      expect(input).toHaveBeenCalledWith("terminal-1", "pwd\r");
      expect(resize).toHaveBeenCalledWith("terminal-1", 120, 40);
    });
    socket.close();
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
  });
});
