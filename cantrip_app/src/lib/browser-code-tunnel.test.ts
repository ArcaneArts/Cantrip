import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CodeProtectedAttachmentWire } from "@cantrip/protocol";

const mocks = vi.hoisted(() => ({
  createTunnelAttachment: vi.fn(),
  deleteTunnelAttachment: vi.fn(),
  getActiveServerUrl: vi.fn(),
  getTunnelDataProtection: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  createTunnelAttachment: mocks.createTunnelAttachment,
  deleteTunnelAttachment: mocks.deleteTunnelAttachment,
  getTunnelDataProtection: mocks.getTunnelDataProtection,
}));

vi.mock("@/lib/server-connections", () => ({
  getActiveServerUrl: mocks.getActiveServerUrl,
}));

import {
  browserCodeAttachmentHealthy,
  startBrowserCodeAttachment,
  stopBrowserCodeAttachment,
  subscribeBrowserCodeAttachmentUnavailable,
} from "./browser-code-tunnel";

const TUNNEL_ID = "11111111-1111-4111-8111-111111111111";
const attachmentTunnels = new Map<string, string>();
const sockets: FakeWebSocket[] = [];
let attachmentSequence = 0;
let autoReadySockets = true;

class FakeBroadcastChannel extends EventTarget {
  constructor(readonly name: string) {
    super();
  }

  close(): void {}

  postMessage(): void {}
}

class FakeWebSocket extends EventTarget {
  static readonly CLOSED = 3;
  static readonly CLOSING = 2;
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;

  readonly attachmentId: string;
  binaryType = "blob";
  readyState = FakeWebSocket.CONNECTING;

  constructor(url: string | URL) {
    super();
    const segments = new URL(url).pathname.split("/");
    this.attachmentId = segments.at(-2) ?? "";
    sockets.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.dispatchEvent(new Event("open"));
    });
  }

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== "string") return;
    const message = JSON.parse(data) as { type?: string };
    if (message.type !== "initialize") return;
    if (autoReadySockets) queueMicrotask(() => this.ready());
  }

  ready(): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "ready",
          attachmentId: this.attachmentId,
          tunnelId: attachmentTunnels.get(this.attachmentId),
          sourceEndpointId: "browser-source",
          destinationEndpointId: "worker-destination",
          expiresAt: "2026-08-24T00:00:00.000Z",
        }),
      }),
    );
  }

  terminalError(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("error"));
  }

  terminalClose(): void {
    this.readyState = FakeWebSocket.CLOSED;
    this.dispatchEvent(new Event("close"));
  }
}

function wire(): CodeProtectedAttachmentWire {
  return {
    attachmentId: TUNNEL_ID,
    tunnelId: TUNNEL_ID,
    sessionId: "22222222-2222-4222-8222-222222222222",
    expiresAt: "2026-08-24T00:00:00.000Z",
    runtime: {
      sessionId: "22222222-2222-4222-8222-222222222222",
      workspaceUri: "file:///worker/project.code-workspace",
      status: "running",
      editorBuild: {
        version: "1.109.5",
        upstreamRevision: "revision",
        patchset: 8,
        fingerprint: "fingerprint",
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
      startedAt: "2026-08-23T00:00:00.000Z",
      lastActivityAt: "2026-08-23T00:00:00.000Z",
      lastError: null,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  attachmentTunnels.clear();
  sockets.length = 0;
  attachmentSequence = 0;
  autoReadySockets = true;

  mocks.getActiveServerUrl.mockReturnValue("https://cantrip.example");
  mocks.getTunnelDataProtection.mockResolvedValue({
    formatVersion: 1,
    algorithm: "AES-256-GCM",
    keyRevision: 1,
    key: "A".repeat(43),
  });
  mocks.createTunnelAttachment.mockImplementation(async (tunnelId: string) => {
    const attachmentId = `browser-attachment-${++attachmentSequence}`;
    attachmentTunnels.set(attachmentId, tunnelId);
    return {
      attachmentId,
      tunnelId,
      secret: "s".repeat(32),
      connectPath: `/api/tunnel-attachments/${attachmentId}/connect`,
      secretExpiresAt: "2026-08-24T00:00:00.000Z",
      expiresAt: "2026-08-24T00:00:00.000Z",
    };
  });
  mocks.deleteTunnelAttachment.mockResolvedValue(undefined);

  const browserWindow = new EventTarget() as EventTarget & {
    location: { origin: string };
  };
  browserWindow.location = { origin: "https://cantrip.example" };
  vi.stubGlobal("window", browserWindow);
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubGlobal("navigator", {
    serviceWorker: {
      register: vi.fn().mockResolvedValue({ active: {} }),
      ready: Promise.resolve({}),
    },
  });
});

afterEach(async () => {
  await stopBrowserCodeAttachment(TUNNEL_ID);
  vi.unstubAllGlobals();
});

describe("browser Code attachment terminal state", () => {
  it("rejects an invalid workspace before allocating a relay attachment", async () => {
    const invalid = wire();
    invalid.runtime.workspaceUri = "https://example.com/not-a-workspace";

    await expect(startBrowserCodeAttachment(invalid)).rejects.toThrow(
      "invalid workspace URI",
    );

    expect(mocks.createTunnelAttachment).not.toHaveBeenCalled();
    expect(sockets).toHaveLength(0);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
  });

  it("releases the relay when session construction fails after startup", async () => {
    class FailingBroadcastChannel {
      constructor() {
        throw new Error("BroadcastChannel construction failed.");
      }
    }
    vi.stubGlobal("BroadcastChannel", FailingBroadcastChannel);

    await expect(startBrowserCodeAttachment(wire())).rejects.toThrow(
      "BroadcastChannel construction failed.",
    );

    expect(mocks.createTunnelAttachment).toHaveBeenCalledOnce();
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
    );
    expect(sockets[0]?.readyState).toBe(FakeWebSocket.CLOSED);
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
  });

  it("evicts and reports the current session when the relay closes", async () => {
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    sockets[0]!.terminalClose();

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledWith({
      tunnelId: TUNNEL_ID,
      reason: "The protected Code relay disconnected.",
    });
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
    );
    unsubscribe();
  });

  it("does not let a replaced session evict the current healthy session", async () => {
    const unavailable = vi.fn();
    const unsubscribe = subscribeBrowserCodeAttachmentUnavailable(unavailable);
    await startBrowserCodeAttachment(wire());
    const replacedSocket = sockets[0]!;

    await startBrowserCodeAttachment(wire());
    replacedSocket.terminalClose();

    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(unavailable).not.toHaveBeenCalled();

    sockets[1]!.terminalError();
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(unavailable).toHaveBeenCalledTimes(1);
    expect(unavailable).toHaveBeenCalledWith({
      tunnelId: TUNNEL_ID,
      reason: "The protected Code relay failed.",
    });
    unsubscribe();
  });

  it("retires a slower concurrent start instead of leaking or overwriting the winner", async () => {
    autoReadySockets = false;
    const first = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    const second = startBrowserCodeAttachment(wire());
    await vi.waitFor(() => expect(sockets).toHaveLength(2));

    sockets[1]!.ready();
    await expect(second).resolves.toMatchObject({
      attachmentId: TUNNEL_ID,
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);

    sockets[0]!.ready();
    await expect(first).resolves.toMatchObject({
      message: "Protected Code attachment startup was superseded.",
      name: "AbortError",
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(true);
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
    );
  });

  it("fences a pending start when shutdown wins the race", async () => {
    autoReadySockets = false;
    const pending = startBrowserCodeAttachment(wire()).then(
      () => null,
      (error: unknown) => error,
    );
    await vi.waitFor(() => expect(sockets).toHaveLength(1));

    await stopBrowserCodeAttachment(TUNNEL_ID);
    sockets[0]!.ready();

    await expect(pending).resolves.toMatchObject({
      message: "Protected Code attachment startup was superseded.",
      name: "AbortError",
    });
    expect(browserCodeAttachmentHealthy(TUNNEL_ID)).toBe(false);
    expect(mocks.deleteTunnelAttachment).toHaveBeenCalledWith(
      "browser-attachment-1",
    );
  });
});
