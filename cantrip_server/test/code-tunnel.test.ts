import type { AddressInfo } from "node:net";

import {
  CODE_ADAPTER_TUNNEL_INITIAL_CREDIT_BYTES,
  CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES,
  type CodeAdapterRequestHead,
  type CodeRuntimeStatus,
  type RemoteSurfaceFrameHeader,
  type TunnelDataPlaneFrameHeader,
  type WorkerCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";

import {
  closeCodeSurfaceServer,
  CodeTunnelBroker,
  createCodeSurfaceServer,
} from "../src/code/tunnel.js";
import type {
  WorkerCommandBus,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
  WorkerTunnelDataPlaneFrameListener,
} from "../src/workers/bridge.js";

const closers: Array<() => Promise<void>> = [];
const EMPTY_PAYLOAD = new Uint8Array();

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

interface FakeStream {
  chunks: Buffer[];
  connect: Extract<TunnelDataPlaneFrameHeader, { kind: "connect" }>;
  consumedBytes: number;
  head: CodeAdapterRequestHead | null;
  outputSequence: number;
}

function encodedResponse(): Buffer {
  const head = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      kind: "http",
      statusCode: 200,
      headers: [
        ["Content-Type", "text/html"],
        [
          "Content-Security-Policy",
          "default-src 'self'; frame-ancestors 'none'",
        ],
        ["Set-Cookie", "vscode-tkn=worker-secret"],
        ["X-Frame-Options", "DENY"],
      ],
    }),
  );
  const encoded = Buffer.allocUnsafe(4 + head.length);
  encoded.writeUInt32BE(head.length, 0);
  head.copy(encoded, 4);
  return Buffer.concat([encoded, Buffer.from("<main>Cantrip Code</main>")]);
}

function encodedWebSocketResponse(): Buffer {
  const head = Buffer.from(
    JSON.stringify({
      protocolVersion: 1,
      kind: "websocket",
      headers: [],
    }),
  );
  const encoded = Buffer.allocUnsafe(4 + head.length);
  encoded.writeUInt32BE(head.length, 0);
  head.copy(encoded, 4);
  return encoded;
}

class LoopbackWorker implements WorkerCommandBus {
  readonly observedHeads: CodeAdapterRequestHead[] = [];
  readonly observedInitialCredits: number[] = [];
  readonly #listeners = new Set<WorkerTunnelDataPlaneFrameListener>();
  readonly #streams = new Map<string, FakeStream>();

  attach(): void {}
  close(): void {}
  isConnected(workerId: string): boolean {
    return workerId === "worker-1";
  }
  sendSurfaceFrame(
    _workerId: string,
    _header: RemoteSurfaceFrameHeader,
    _payload: Uint8Array,
  ): boolean {
    return false;
  }
  subscribeSurfaceFrames(
    _workerId: string,
    _listener: WorkerSurfaceFrameListener,
  ): () => void {
    return () => undefined;
  }
  subscribeWorkerDisconnect(): () => void {
    return () => undefined;
  }
  subscribeTunnelDataPlaneFrames(
    _workerId: string,
    listener: WorkerTunnelDataPlaneFrameListener,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  sendTunnelDataPlaneFrame(
    _workerId: string,
    header: TunnelDataPlaneFrameHeader,
    payload: Uint8Array,
  ): boolean {
    const streamKey = `${header.attachmentId}\0${header.connectionId}`;
    if (header.kind === "connect") {
      this.observedInitialCredits.push(header.initialCreditBytes);
      const stream = {
        chunks: [],
        connect: header,
        consumedBytes: 0,
        head: null,
        outputSequence: 0,
      };
      this.#streams.set(streamKey, stream);
      this.#emit(stream, { kind: "accepted", initialCreditBytes: 1024 * 1024 });
      return true;
    }
    const stream = this.#streams.get(streamKey);
    if (!stream) return false;
    if (
      header.kind === "data" &&
      header.direction === "source-to-destination"
    ) {
      stream.chunks.push(Buffer.from(payload));
      this.#emit(stream, {
        kind: "credit",
        direction: "source-to-destination",
        bytes: payload.byteLength,
      });
      const input = Buffer.concat(stream.chunks);
      if (!stream.head && input.byteLength >= 4) {
        const headLength = input.readUInt32BE(0);
        if (input.byteLength >= 4 + headLength) {
          stream.head = JSON.parse(
            input.subarray(4, 4 + headLength).toString("utf8"),
          ) as CodeAdapterRequestHead;
          stream.consumedBytes = 4 + headLength;
          this.observedHeads.push(stream.head);
          if (stream.head.kind === "websocket") {
            this.#emit(
              stream,
              { kind: "data", direction: "destination-to-source" },
              encodedWebSocketResponse(),
            );
          }
        }
      }
      if (stream.head?.kind === "websocket") {
        while (
          input.byteLength >=
          stream.consumedBytes + CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES
        ) {
          const length = input.readUInt32BE(stream.consumedBytes + 1);
          const recordLength =
            CODE_ADAPTER_WEBSOCKET_RECORD_HEADER_BYTES + length;
          if (input.byteLength < stream.consumedBytes + recordLength) break;
          this.#emit(
            stream,
            { kind: "data", direction: "destination-to-source" },
            input.subarray(
              stream.consumedBytes,
              stream.consumedBytes + recordLength,
            ),
          );
          stream.consumedBytes += recordLength;
        }
      }
      return true;
    }
    if (
      header.kind === "half-close" &&
      header.direction === "source-to-destination"
    ) {
      const input = Buffer.concat(stream.chunks);
      if (!stream.head)
        throw new Error("Expected a complete Code request head.");
      this.#emit(
        stream,
        { kind: "data", direction: "destination-to-source" },
        encodedResponse(),
      );
      this.#emit(stream, {
        kind: "half-close",
        direction: "destination-to-source",
      });
      return true;
    }
    return true;
  }
  request(
    _workerId: string,
    _command: WorkerCommand,
    _options?: WorkerRequestOptions,
  ): Promise<unknown> {
    return Promise.reject(new Error("Not used by the tunnel test."));
  }

  #emit(
    stream: FakeStream,
    frame:
      | { kind: "accepted"; initialCreditBytes: number }
      | { kind: "credit"; direction: "source-to-destination"; bytes: number }
      | { kind: "data"; direction: "destination-to-source" }
      | { kind: "half-close"; direction: "destination-to-source" },
    payload: Uint8Array = EMPTY_PAYLOAD,
  ): void {
    const header = {
      protocolVersion: 1 as const,
      tunnelId: stream.connect.tunnelId,
      attachmentId: stream.connect.attachmentId,
      sourceEndpointId: stream.connect.sourceEndpointId,
      destinationEndpointId: stream.connect.destinationEndpointId,
      connectionId: stream.connect.connectionId,
      sequence: stream.outputSequence++,
      ...frame,
    } as TunnelDataPlaneFrameHeader;
    queueMicrotask(() => {
      for (const listener of this.#listeners) listener(header, payload);
    });
  }
}

const runtime: CodeRuntimeStatus = {
  sessionId: "session-1",
  workspaceUri: "file:///worker/state/project.code-workspace",
  status: "running",
  editorBuild: {
    version: "1.109.5-cantrip.1",
    upstreamRevision: "a".repeat(40),
    patchset: 1,
    fingerprint: "b".repeat(64),
  },
  processInstanceId: "process-1",
  bridgeConnected: true,
  dirtyEditors: [],
  workbench: {
    activeEditor: null,
    git: null,
    conflicts: [],
    savePolicy: "always",
    agentStatus: "idle",
  },
  startedAt: "2026-08-08T12:00:00.000Z",
  lastActivityAt: "2026-08-08T12:00:00.000Z",
  lastError: null,
};

describe("Cantrip Code isolated editor surface", () => {
  it("charges generic Code streams to hosted relay quotas", async () => {
    const worker = new LoopbackWorker();
    const consumeRelayBytes = vi.fn(() => false);
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["tauri://localhost"],
      consumeRelayBytes,
    });
    const attachment = await broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const surface = createCodeSurfaceServer(broker, "http://127.0.0.1:4311");
    await new Promise<void>((resolve) =>
      surface.listen(0, "127.0.0.1", resolve),
    );
    closers.push(async () => {
      await closeCodeSurfaceServer(surface);
      await broker.close();
    });
    const { port } = surface.address() as AddressInfo;

    const response = await fetch(
      `http://127.0.0.1:${port}${new URL(attachment.url).pathname}`,
    );
    expect(response.status).toBe(429);
    expect(await response.text()).toContain("relay bandwidth quota");
    expect(consumeRelayBytes).toHaveBeenCalledWith(
      "user-1",
      "worker-1",
      expect.any(Number),
    );
  });

  it("keeps concurrent view attachments independent", async () => {
    const worker = new LoopbackWorker();
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["tauri://localhost"],
    });
    const first = await broker.createAttachment({
      authSessionId: "auth-session-1",
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const second = await broker.createAttachment({
      authSessionId: "auth-session-2",
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const firstToken = new URL(first.url).pathname.split("/")[2]!;
    const secondToken = new URL(second.url).pathname.split("/")[2]!;

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attachmentId).not.toBe(second.attachmentId);
    expect(
      broker.prepareDirectAttachment(first.attachmentId, "user-1"),
    ).toMatchObject({
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    expect(
      broker.prepareDirectAttachment(first.attachmentId, "user-2"),
    ).toBeNull();
    expect(broker.hasAttachment(firstToken)).toBe(true);
    expect(broker.hasAttachment(secondToken)).toBe(true);
    expect(await broker.revokeAttachment(first.attachmentId, "user-2")).toBe(
      false,
    );
    expect(await broker.revokeAttachment(first.attachmentId, "user-1")).toBe(
      true,
    );
    expect(broker.hasAttachment(firstToken)).toBe(false);
    expect(broker.hasAttachment(secondToken)).toBe(true);
    await broker.revokeAuthSession("auth-session-2");
    expect(broker.hasAttachment(secondToken)).toBe(false);
    await broker.close();
  });

  it("uses generic streams while sanitizing worker responses", async () => {
    const worker = new LoopbackWorker();
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["http://127.0.0.1:5173", "tauri://localhost"],
    });
    const attachment = await broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    expect(attachment.url).not.toContain("worker-secret");
    const surface = createCodeSurfaceServer(broker, "http://127.0.0.1:4311");
    await new Promise<void>((resolve) =>
      surface.listen(0, "127.0.0.1", resolve),
    );
    closers.push(async () => {
      await closeCodeSurfaceServer(surface);
      await broker.close();
    });
    const { port } = surface.address() as AddressInfo;
    const attachmentPath = new URL(attachment.url).pathname;
    expect(new URL(attachment.url).searchParams.get("workspace")).toBe(
      "/worker/state/project.code-workspace",
    );

    const response = await fetch(`http://127.0.0.1:${port}${attachmentPath}`);
    expect(await response.text()).toBe("<main>Cantrip Code</main>");
    expect(worker.observedHeads[0]).toMatchObject({
      kind: "http",
      sessionId: "session-1",
      basePath: attachmentPath.replace(/\/$/u, ""),
    });
    expect(worker.observedInitialCredits[0]).toBe(
      CODE_ADAPTER_TUNNEL_INITIAL_CREDIT_BYTES,
    );
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("x-frame-options")).toBeNull();
    expect(response.headers.get("content-security-policy")).toBe(
      "default-src 'self'; frame-ancestors 'self' http://127.0.0.1:5173 tauri://localhost",
    );
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const missing = await fetch(
      `http://127.0.0.1:${port}/code/${"x".repeat(43)}/`,
    );
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain(
      "cantrip-code-attachment-unavailable-v1",
    );
  });

  it("carries WebSocket messages through the generic stream adapter", async () => {
    const worker = new LoopbackWorker();
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["tauri://localhost"],
    });
    const attachment = await broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      projectId: "project-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const surface = createCodeSurfaceServer(broker, "http://127.0.0.1:4311");
    await new Promise<void>((resolve) =>
      surface.listen(0, "127.0.0.1", resolve),
    );
    closers.push(async () => {
      await closeCodeSurfaceServer(surface);
      await broker.close();
    });
    const { port } = surface.address() as AddressInfo;
    const socket = new WebSocket(
      `ws://127.0.0.1:${port}${new URL(attachment.url).pathname}socket`,
      { headers: { origin: "http://127.0.0.1:4311" } },
    );
    await new Promise<void>((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    socket.send("ping");
    const echoed = await new Promise<{ binary: boolean; text: string }>(
      (resolve, reject) => {
        socket.once("message", (data, binary) =>
          resolve({ binary, text: data.toString() }),
        );
        socket.once("error", reject);
      },
    );
    expect(echoed).toEqual({ binary: false, text: "ping" });
    expect(worker.observedHeads).toContainEqual(
      expect.objectContaining({ kind: "websocket", sessionId: "session-1" }),
    );
    socket.close();
  });
});
