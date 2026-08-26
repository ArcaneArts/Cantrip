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
      identity: { attachmentId: string; tunnelId: string };
    };
    queueMicrotask(() =>
      this.onmessage?.({
        data: JSON.stringify({
          type: "ready",
          attachmentId: initialize.identity.attachmentId,
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
          token: "b".repeat(43),
          url: "ws://127.0.0.1:43123/",
        },
      ),
    ).resolves.toBe("local");
    expect(connection.activate).toHaveBeenCalledOnce();

    await stopDesktopTunnelWorkerLinkForward(tunnelId);
  });
});
