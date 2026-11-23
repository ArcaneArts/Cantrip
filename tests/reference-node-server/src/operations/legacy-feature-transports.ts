import type { LegacyFeatureTransportEndpoint } from "./metrics.js";

/** RFC 9745 structured-field date for 2026-08-27T00:00:00Z. */
export const LEGACY_FEATURE_TRANSPORT_DEPRECATION = "@1787788800";
export const LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK =
  '<https://github.com/ArcaneArts/Cantrip/blob/main/docs/NETWORK.md#legacy-feature-relay-compatibility>; rel="deprecation"; type="text/markdown"';

const endpointByRoute = new Map<string, LegacyFeatureTransportEndpoint>([
  ["GET /api/remote-surfaces/:surfaceId/connect", "remote-surface-transport"],
  ["POST /api/terminals/:terminalId/direct", "terminal-direct"],
  ["GET /api/terminals/:terminalId/connect", "terminal-relay"],
  ["POST /api/tunnel-attachments/:attachmentId/direct", "tunnel-direct"],
  [
    "POST /api/tunnel-attachments/:attachmentId/direct-activate",
    "tunnel-direct-activate",
  ],
  ["GET /api/tunnel-attachments/:attachmentId/connect", "tunnel-relay"],
]);

export function legacyFeatureTransportEndpoint(
  method: string,
  route: string,
): LegacyFeatureTransportEndpoint | null {
  return endpointByRoute.get(`${method.toUpperCase()} ${route}`) ?? null;
}
