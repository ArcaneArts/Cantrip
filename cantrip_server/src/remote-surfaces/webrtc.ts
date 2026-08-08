import { createHmac } from "node:crypto";

import {
  remoteSurfaceWebRtcConfigurationSchema,
  type RemoteSurfaceWebRtcConfiguration,
} from "@cantrip/protocol";

import type { RemoteSurfaceTurnConfig } from "../config.js";

export function createRemoteSurfaceWebRtcConfiguration(
  config: RemoteSurfaceTurnConfig,
  userId: string,
  now = Date.now(),
): RemoteSurfaceWebRtcConfiguration {
  const expiresAt = Math.floor(now / 1_000) + config.ttlSeconds;
  const username = `${expiresAt}:${userId}`;
  const credential = createHmac("sha1", config.sharedSecret)
    .update(username)
    .digest("base64");

  return remoteSurfaceWebRtcConfigurationSchema.parse({
    iceServers: [
      {
        urls: config.urls,
        username,
        credential,
      },
    ],
    iceTransportPolicy: "relay",
    negotiationTimeoutMs: config.negotiationTimeoutMs,
  });
}
