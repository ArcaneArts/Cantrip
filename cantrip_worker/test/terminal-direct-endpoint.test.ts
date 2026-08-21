import { randomUUID } from "node:crypto";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "@cantrip/crypto";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";

import { TerminalDirectEndpointManager } from "../src/terminal-direct-endpoint.js";
import type { TerminalManager } from "../src/terminal-manager.js";
import {
  openWorkerSurfaceStreamContent,
  protectWorkerSurfaceStreamContent,
  SurfaceStreamReplayGuard,
} from "../src/surface-stream-encryption.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

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
    const serverId = "https://cantrip.example";
    const ownerId = "terminal-owner";
    const componentKey = randomBytes(32);
    const encryption = {
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
      ownerId: () => ownerId,
      serverIdentity: () => serverId,
    } as unknown as WorkerEncryptionService;
    manager.setEncryptionService(encryption, new SurfaceStreamReplayGuard());
    managers.push(manager);
    const capabilityId = randomUUID();
    const operationId = randomUUID();
    const target = await manager.prepare(capabilityId, "terminal-1");
    if (target.kind !== "tcp") throw new Error("expected loopback target");
    const socket = new WebSocket(
      `ws://${target.host}:${target.port}/terminal?operationId=${operationId}`,
    );
    const messages: unknown[] = [];
    socket.on("message", (data) => messages.push(JSON.parse(String(data))));
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    await vi.waitFor(() => expect(messages).toHaveLength(2));
    expect(messages[0]).toEqual({ type: "ready" });
    const output = messages[1] as {
      operationId: string;
      protectedData: unknown;
      sequence: number;
      type: "output";
    };
    expect(output).toMatchObject({ type: "output", operationId, sequence: 0 });
    await expect(
      openWorkerSurfaceStreamContent({
        context: {
          serverId,
          surfaceKind: "terminal",
          surfaceId: "terminal-1",
          operationId,
          direction: "output",
          sequence: 0,
        },
        opaque: output.protectedData,
        schema: terminalOutputContentSchema,
        service: encryption,
      }),
    ).resolves.toEqual({ type: "terminal.output", data: "hello" });

    const protectedData = await protectWorkerSurfaceStreamContent({
      context: {
        serverId,
        surfaceKind: "terminal",
        surfaceId: "terminal-1",
        operationId,
        direction: "input",
        sequence: 0,
      },
      content: { type: "terminal.input" as const, data: "pwd\r" },
      schema: terminalInputContentSchema,
      service: encryption,
    });
    socket.send(
      JSON.stringify({
        type: "input",
        operationId,
        sequence: 0,
        protectedData,
      }),
    );
    socket.send(JSON.stringify({ type: "resize", cols: 120, rows: 40 }));
    await vi.waitFor(() => {
      expect(input).toHaveBeenCalledWith("terminal-1", "pwd\r");
      expect(resize).toHaveBeenCalledWith("terminal-1", 120, 40);
    });
    socket.send(
      JSON.stringify({
        type: "input",
        operationId,
        sequence: 0,
        protectedData,
      }),
    );
    await vi.waitFor(() => expect(messages).toHaveLength(3));
    expect(messages[2]).toEqual({
      type: "error",
      message: "Invalid protected terminal message.",
    });
    expect(input).toHaveBeenCalledOnce();
    socket.close();
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());
  });
});
