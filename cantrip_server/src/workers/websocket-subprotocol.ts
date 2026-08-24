import type { IncomingMessage } from "node:http";

import { WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL } from "@cantrip/protocol";

const WORKER_CONNECT_PATH = "/api/internal/workers/connect";

function requestPath(request: IncomingMessage): string {
  try {
    return new URL(request.url ?? "/", "http://cantrip.invalid").pathname;
  } catch {
    return "";
  }
}

/**
 * Negotiates the authenticated-ready protocol only for worker command
 * connections. Every other WebSocket route retains ws' existing first-offered
 * behavior, including tunnel protocols that carry an attachment secret.
 */
export function selectCantripWebSocketSubprotocol(
  protocols: Set<string>,
  request: IncomingMessage,
): string | false {
  if (
    requestPath(request) === WORKER_CONNECT_PATH &&
    protocols.has(WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL)
  ) {
    return WORKER_WEBSOCKET_AUTH_READY_SUBPROTOCOL;
  }
  return protocols.values().next().value ?? false;
}
