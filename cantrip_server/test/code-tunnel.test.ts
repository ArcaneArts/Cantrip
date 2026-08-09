import type { AddressInfo } from "node:net";

import type {
  CodeRuntimeStatus,
  CodeTunnelFrameHeader,
  RemoteSurfaceFrameHeader,
  WorkerCommand,
} from "@cantrip/protocol";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeCodeSurfaceServer,
  CodeTunnelBroker,
  createCodeSurfaceServer,
} from "../src/code/tunnel.js";
import type {
  WorkerCodeTunnelFrameListener,
  WorkerCommandBus,
  WorkerRequestOptions,
  WorkerSurfaceFrameListener,
} from "../src/workers/bridge.js";

const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

class LoopbackWorker implements WorkerCommandBus {
  readonly #listeners = new Set<WorkerCodeTunnelFrameListener>();

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
  subscribeCodeTunnelFrames(
    _workerId: string,
    listener: WorkerCodeTunnelFrameListener,
  ): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
  sendCodeTunnelFrame(
    _workerId: string,
    header: CodeTunnelFrameHeader,
    _payload: Uint8Array,
  ): boolean {
    if (header.kind !== "http-request-start") return true;
    queueMicrotask(() => {
      const base = {
        protocolVersion: 1 as const,
        attachmentId: header.attachmentId,
        sessionId: header.sessionId,
        streamId: header.streamId,
      };
      this.#emit(
        {
          ...base,
          kind: "http-response-start",
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
        },
        new Uint8Array(),
      );
      this.#emit(
        { ...base, kind: "http-response-data" },
        new TextEncoder().encode("<main>Cantrip Code</main>"),
      );
      this.#emit({ ...base, kind: "http-response-end" }, new Uint8Array());
    });
    return true;
  }
  request(
    _workerId: string,
    _command: WorkerCommand,
    _options?: WorkerRequestOptions,
  ): Promise<unknown> {
    return Promise.reject(new Error("Not used by the tunnel test."));
  }

  #emit(header: CodeTunnelFrameHeader, payload: Uint8Array): void {
    for (const listener of this.#listeners) listener(header, payload);
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
  it("keeps concurrent view attachments independent", async () => {
    const worker = new LoopbackWorker();
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["tauri://localhost"],
    });
    const first = broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const second = broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    const firstToken = new URL(first.url).pathname.split("/")[2]!;
    const secondToken = new URL(second.url).pathname.split("/")[2]!;

    expect(first.sessionId).toBe(second.sessionId);
    expect(first.attachmentId).not.toBe(second.attachmentId);
    expect(broker.hasAttachment(firstToken)).toBe(true);
    expect(broker.hasAttachment(secondToken)).toBe(true);
    expect(broker.revokeAttachment(first.attachmentId, "user-2")).toBe(false);
    expect(broker.revokeAttachment(first.attachmentId, "user-1")).toBe(true);
    expect(broker.hasAttachment(firstToken)).toBe(false);
    expect(broker.hasAttachment(secondToken)).toBe(true);
    broker.close();
  });

  it("requires an attachment token and sanitizes worker responses", async () => {
    const worker = new LoopbackWorker();
    const broker = new CodeTunnelBroker(worker, {
      surfaceOrigin: "http://127.0.0.1:4311",
      allowedFrameAncestors: ["http://127.0.0.1:5173", "tauri://localhost"],
    });
    const attachment = broker.createAttachment({
      codeTabId: "code-1",
      ownerId: "user-1",
      runtime,
      sessionId: runtime.sessionId,
      workerId: "worker-1",
    });
    expect(attachment.url).not.toContain("worker-secret");
    const surface = createCodeSurfaceServer(broker, "http://127.0.0.1:4311");
    await new Promise<void>((resolve) =>
      surface.listen(0, "127.0.0.1", resolve),
    );
    closers.push(() => closeCodeSurfaceServer(surface));
    const { port } = surface.address() as AddressInfo;
    const attachmentPath = new URL(attachment.url).pathname;
    expect(new URL(attachment.url).searchParams.get("workspace")).toBe(
      "/worker/state/project.code-workspace",
    );

    const response = await fetch(
      `http://127.0.0.1:${port}${attachmentPath}?workspace=${encodeURIComponent("/worker/state/project.code-workspace")}`,
    );
    expect(await response.text()).toBe("<main>Cantrip Code</main>");
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
    expect(
      await fetch(`http://127.0.0.1:${port}/api/bootstrap`).then(
        (result) => result.status,
      ),
    ).toBe(404);
  });
});
