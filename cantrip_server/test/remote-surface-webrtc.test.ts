import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createRemoteSurfaceWebRtcConfiguration } from "../src/remote-surfaces/webrtc.js";

describe("Remote Surface WebRTC credentials", () => {
  it("derives short-lived TURN REST credentials without exposing the secret", () => {
    const now = Date.UTC(2026, 7, 8, 12, 0, 0);
    const configuration = createRemoteSurfaceWebRtcConfiguration(
      {
        urls: ["turn:relay.cantrip.art:3478?transport=udp"],
        sharedSecret: "long-lived-server-secret",
        ttlSeconds: 600,
        negotiationTimeoutMs: 8_000,
      },
      "local-user",
      now,
    );
    const username = `${Math.floor(now / 1_000) + 600}:local-user`;
    expect(configuration.iceServers[0]).toEqual({
      urls: ["turn:relay.cantrip.art:3478?transport=udp"],
      username,
      credential: createHmac("sha1", "long-lived-server-secret")
        .update(username)
        .digest("base64"),
    });
    expect(JSON.stringify(configuration)).not.toContain(
      "long-lived-server-secret",
    );
    expect(configuration.iceTransportPolicy).toBe("relay");
  });
});
