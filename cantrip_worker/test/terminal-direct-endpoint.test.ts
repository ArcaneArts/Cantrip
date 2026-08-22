import { randomUUID } from "node:crypto";

import WebSocket from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { randomBytes } from "@cantrip/crypto";
import {
  terminalInputContentSchema,
  terminalOutputContentSchema,
} from "@cantrip/protocol/surface-stream";

import { TerminalDirectEndpointManager } from "../src/terminal-direct-endpoint.js";
import type { ManagedRunSupervisor } from "../src/managed-run-supervisor.js";
import type {
  TerminalManager,
  TerminalRuntimeEvent,
} from "../src/terminal-manager.js";
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
          emit({ type: "terminal.output", data: "hello" });
          emit({ type: "terminal.ready" });
          return new Promise(() => undefined);
        },
      ),
      detach,
      input,
      resize,
    } as unknown as TerminalManager;
    const manager = new TerminalDirectEndpointManager(terminal);
    const streamServerId = "server-persistent-id";
    const ownerId = "terminal-owner";
    const componentKey = randomBytes(32);
    const encryption = {
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
      ownerId: () => ownerId,
    } as unknown as WorkerEncryptionService;
    manager.setEncryptionService(encryption, new SurfaceStreamReplayGuard());
    managers.push(manager);
    const capabilityId = randomUUID();
    const operationId = randomUUID();
    const target = await manager.prepare(
      capabilityId,
      "terminal-1",
      streamServerId,
    );
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
    const output = messages[0] as {
      operationId: string;
      protectedData: unknown;
      sequence: number;
      type: "output";
    };
    expect(output).toMatchObject({ type: "output", operationId, sequence: 0 });
    expect(messages[1]).toEqual({ type: "ready" });
    await expect(
      openWorkerSurfaceStreamContent({
        context: {
          serverId: streamServerId,
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
        serverId: streamServerId,
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

  it("attaches a declared Run surface only to its existing managed PTY", async () => {
    const terminal = {
      attachExisting: vi.fn(),
      detach: vi.fn(),
      input: vi.fn(),
      resize: vi.fn(),
    } as unknown as TerminalManager;
    const runId = randomUUID();
    const detach = vi.fn(() => ({ status: "detached" as const }));
    const managedRuns = {
      has: vi.fn((candidate: string) => candidate === runId),
      attach: vi.fn(
        (
          _runId: string,
          _attachmentId: string,
          _cols: number,
          _rows: number,
          emit: (event: TerminalRuntimeEvent) => void,
        ) => {
          emit({ type: "terminal.ready" });
          return new Promise(() => undefined);
        },
      ),
      detach,
      input: vi.fn(),
      resize: vi.fn(),
    } as unknown as ManagedRunSupervisor;
    const manager = new TerminalDirectEndpointManager(terminal);
    manager.setManagedRunSupervisor(managedRuns);
    const componentKey = randomBytes(32);
    const encryption = {
      componentKey: () => ({
        key: new Uint8Array(componentKey),
        keyRevision: 1,
      }),
      ownerId: () => "terminal-owner",
    } as unknown as WorkerEncryptionService;
    manager.setEncryptionService(encryption, new SurfaceStreamReplayGuard());
    managers.push(manager);

    const operationId = randomUUID();
    const target = await manager.prepare(
      randomUUID(),
      runId,
      "server-persistent-id",
      runId,
    );
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
    await vi.waitFor(() => expect(messages).toContainEqual({ type: "ready" }));
    expect(managedRuns.attach).toHaveBeenCalledWith(
      runId,
      expect.stringMatching(/^direct:/u),
      80,
      24,
      expect.any(Function),
    );
    expect(terminal.attachExisting).not.toHaveBeenCalled();
    socket.close();
    await vi.waitFor(() => expect(detach).toHaveBeenCalledOnce());

    vi.mocked(managedRuns.has).mockReturnValue(false);
    const unavailableTarget = await manager.prepare(
      randomUUID(),
      runId,
      "server-persistent-id",
      runId,
    );
    if (unavailableTarget.kind !== "tcp") {
      throw new Error("expected loopback target");
    }
    const unavailable = new WebSocket(
      `ws://${unavailableTarget.host}:${unavailableTarget.port}/terminal?operationId=${randomUUID()}`,
    );
    const closed = new Promise<number>((resolve, reject) => {
      unavailable.once("close", (code) => resolve(code));
      unavailable.once("error", reject);
    });
    await expect(closed).resolves.toBe(1011);
    expect(managedRuns.attach).toHaveBeenCalledOnce();
    expect(terminal.attachExisting).not.toHaveBeenCalled();
  });
});
