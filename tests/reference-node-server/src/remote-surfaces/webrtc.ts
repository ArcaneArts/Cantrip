import { createHmac } from "node:crypto";

import {
  remoteSurfaceWebRtcConfigurationSchema,
  type RemoteSurfaceWebRtcConfiguration,
} from "@cantrip/protocol";

import type { RemoteSurfaceWebRtcConfig } from "../config.js";

export function createRemoteSurfaceWebRtcConfiguration(
  config: RemoteSurfaceWebRtcConfig,
  userId: string,
  now = Date.now(),
): RemoteSurfaceWebRtcConfiguration {
  const iceServers: RemoteSurfaceWebRtcConfiguration["iceServers"] = [];
  if (config.stunUrls.length > 0) iceServers.push({ urls: config.stunUrls });
  if (config.turn) {
    const expiresAt = Math.floor(now / 1_000) + config.turn.ttlSeconds;
    const username = `${expiresAt}:${userId}`;
    const credential = createHmac("sha1", config.turn.sharedSecret)
      .update(username)
      .digest("base64");
    iceServers.push({ urls: config.turn.urls, username, credential });
  }

  return remoteSurfaceWebRtcConfigurationSchema.parse({
    iceServers,
    iceTransportPolicy: config.iceTransportPolicy,
    negotiationTimeoutMs: config.negotiationTimeoutMs,
  });
}
