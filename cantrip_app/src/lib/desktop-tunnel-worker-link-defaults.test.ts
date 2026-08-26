import type { WorkerLinkTunnelRoute } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
  openLink: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

vi.mock("@/lib/tunnel-worker-link", () => ({
  openTunnelWorkerLink: mocks.openLink,
}));

const tunnelId = "tunnel-webkit-timers";
const attachmentId = "attachment-webkit-timers";

class FakeWebSocket {
  binaryType: BinaryType = "blob";
  bufferedAmount = 0;
  readyState = 1;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;

  constructor(_url: string) {
    queueMicrotask(() => this.onopen?.({} as Event));
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    queueMicrotask(() => this.onclose?.({} as CloseEvent));
  }

  send(data: ArrayBuffer | string): void {
    if (typeof data !== "string") return;
    const initialize = JSON.parse(data) as {
      claimGeneration: number;
      identity: { attachmentId: string; tunnelId: string };
      nativeForwardGeneration: string;
    };
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          type: "ready",
          attachmentId: initialize.identity.attachmentId,
          claimGeneration: initialize.claimGeneration,
          nativeForwardGeneration: initialize.nativeForwardGeneration,
          tunnelId: initialize.identity.tunnelId,
        }),
      } as MessageEvent<string>),
    );
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
  mocks.invoke.mockReset();
  mocks.openLink.mockReset();
});

describe("desktop tunnel WorkerLink browser defaults", () => {
  it("calls Window timers with the Window receiver required by WebKit", async () => {
    const nativeSetTimeout = globalThis.setTimeout;
    const nativeClearTimeout = globalThis.clearTimeout;
    const receiverCheckedSetTimeout = function (
      this: typeof globalThis,
      callback: TimerHandler,
      delayMs?: number,
    ) {
      if (this !== globalThis) {
        throw new TypeError(
          "Can only call Window.setTimeout on instances of Window",
        );
      }
      return Reflect.apply(nativeSetTimeout, globalThis, [callback, delayMs]);
    };
    const receiverCheckedClearTimeout = function (
      this: typeof globalThis,
      timer: ReturnType<typeof setTimeout>,
    ) {
      if (this !== globalThis) {
        throw new TypeError(
          "Can only call Window.clearTimeout on instances of Window",
        );
      }
      return Reflect.apply(nativeClearTimeout, globalThis, [timer]);
    };
    vi.stubGlobal("setTimeout", receiverCheckedSetTimeout);
    vi.stubGlobal("clearTimeout", receiverCheckedClearTimeout);
    vi.stubGlobal("WebSocket", FakeWebSocket);

    const route: WorkerLinkTunnelRoute = {
      tunnelId,
      attachmentId,
      sourceEndpointId: "worker-link-client:grant-webkit-timers",
      destinationEndpointId: "worker-link-worker:worker-1",
      target: { kind: "tcp", host: "127.0.0.1", port: 4321 },
    };
    const connection = {
      bridgeAuthority: {
        accountSessionId: "account-session-1",
        channelId: "11111111-1111-4111-8111-111111111111",
        clientInstanceId: "client-instance-1",
        connectionId: "22222222-2222-4222-8222-222222222222",
        grantGeneration: 1,
        grantId: "33333333-3333-4333-8333-333333333333",
        ownerId: "owner-1",
        routeGeneration: 1,
        serverGeneration: "server-generation-1",
        serverId: "server-1",
        sessionId: "44444444-4444-4444-8444-444444444444",
        workerId: "worker-1",
        workerProcessGeneration: "worker-generation-1",
      },
      bufferedAmount: 0,
      activate: vi.fn(),
      close: vi.fn(),
      route: "local" as const,
      send: vi.fn(() => true),
      tunnelRoute: route,
    };
    mocks.openLink.mockResolvedValue(connection);
    mocks.invoke.mockResolvedValue(undefined);

    const {
      attachDesktopTunnelWorkerLinkForward,
      stopDesktopTunnelWorkerLinkForward,
    } = await import("./desktop-tunnel-worker-link");

    await expect(
      attachDesktopTunnelWorkerLinkForward(
        {
          attachmentId,
          diagnosticTraceId: "trace-webkit-timers",
          tunnelId,
          workerId: "worker-1",
        },
        {
          claimGeneration: 1,
          claimId: "55555555-5555-4555-8555-555555555555",
          expiresAtEpochMs: Date.now() + 30_000,
          nativeForwardGeneration: "66666666-6666-4666-8666-666666666666",
          token: "b".repeat(43),
          url: "ws://127.0.0.1:43123/",
        },
      ),
    ).resolves.toBe("local");
    expect(connection.activate).toHaveBeenCalledOnce();

    await stopDesktopTunnelWorkerLinkForward(tunnelId);
  });
});
