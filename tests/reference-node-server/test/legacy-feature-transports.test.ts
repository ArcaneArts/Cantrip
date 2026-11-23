import { describe, expect, it } from "vitest";

import {
  LEGACY_FEATURE_TRANSPORT_DEPRECATION,
  LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK,
  legacyFeatureTransportEndpoint,
} from "../src/operations/legacy-feature-transports.js";

describe("legacy feature transport compatibility", () => {
  it.each([
    [
      "GET",
      "/api/remote-surfaces/:surfaceId/connect",
      "remote-surface-transport",
    ],
    ["POST", "/api/terminals/:terminalId/direct", "terminal-direct"],
    ["GET", "/api/terminals/:terminalId/connect", "terminal-relay"],
    ["POST", "/api/tunnel-attachments/:attachmentId/direct", "tunnel-direct"],
    [
      "POST",
      "/api/tunnel-attachments/:attachmentId/direct-activate",
      "tunnel-direct-activate",
    ],
    ["GET", "/api/tunnel-attachments/:attachmentId/connect", "tunnel-relay"],
  ])("classifies %s %s as %s", (method, route, endpoint) => {
    expect(legacyFeatureTransportEndpoint(method, route)).toBe(endpoint);
  });

  it("does not classify current WorkerLink or unrelated routes", () => {
    expect(
      legacyFeatureTransportEndpoint(
        "GET",
        "/api/worker-links/:sessionId/relay",
      ),
    ).toBeNull();
    expect(legacyFeatureTransportEndpoint("GET", "/api/live")).toBeNull();
  });

  it("publishes a standards-based deprecation date and documentation link", () => {
    expect(LEGACY_FEATURE_TRANSPORT_DEPRECATION).toBe("@1787788800");
    expect(LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK).toContain(
      'rel="deprecation"',
    );
    expect(LEGACY_FEATURE_TRANSPORT_DEPRECATION_LINK).toContain(
      "#legacy-feature-relay-compatibility",
    );
  });
});
