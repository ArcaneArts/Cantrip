import type { IncomingMessage } from "node:http";

import {
  WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
  WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL,
  WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
  WORKER_WEBSOCKET_SUBPROTOCOLS,
} from "@cantrip/protocol";
import { describe, expect, it } from "vitest";

import { selectCantripWebSocketSubprotocol } from "../src/workers/websocket-subprotocol.js";

function request(url: string): IncomingMessage {
  return { url } as IncomingMessage;
}

describe("Cantrip WebSocket subprotocol selection", () => {
  it("selects authenticated-ready for a modern worker offer", () => {
    expect(
      selectCantripWebSocketSubprotocol(
        new Set(WORKER_WEBSOCKET_SUBPROTOCOLS),
        request(
          "/api/internal/workers/connect?workerId=worker-1&connectionGeneration=11111111-1111-4111-8111-111111111111",
        ),
      ),
    ).toBe(WORKER_WEBSOCKET_AUTH_READY_V2_SUBPROTOCOL);
  });

  it("preserves legacy worker negotiation when modern readiness is absent", () => {
    expect(
      selectCantripWebSocketSubprotocol(
        new Set([
          WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL,
          WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL,
        ]),
        request(
          "/api/internal/workers/connect?workerId=worker-1&connectionGeneration=11111111-1111-4111-8111-111111111111",
        ),
      ),
    ).toBe(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL);
    expect(
      selectCantripWebSocketSubprotocol(
        new Set([WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL]),
        request("/api/internal/workers/connect?workerId=worker-1"),
      ),
    ).toBe(WORKER_WEBSOCKET_LEGACY_SUBPROTOCOL);
    expect(
      selectCantripWebSocketSubprotocol(
        new Set<string>(),
        request("/api/internal/workers/connect?workerId=worker-1"),
      ),
    ).toBe(false);
  });

  it("preserves first-offered tunnel and non-worker protocols", () => {
    const tunnelProtocol = `cantrip-tunnel-v1.${"s".repeat(32)}`;
    expect(
      selectCantripWebSocketSubprotocol(
        new Set([tunnelProtocol, WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL]),
        request("/api/tunnel-attachments/attachment-1/connect"),
      ),
    ).toBe(tunnelProtocol);
    expect(
      selectCantripWebSocketSubprotocol(
        new Set(["app-live-v1", "app-live-v2"]),
        request("/api/live"),
      ),
    ).toBe("app-live-v1");
  });
});
