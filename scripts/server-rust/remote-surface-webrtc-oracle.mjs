import { createRemoteSurfaceWebRtcConfiguration } from "../../cantrip_server/src/remote-surfaces/webrtc.ts";
const cases = [];
for (const [stun, turn, policy, ttl, secret] of [
  [[], [], "all", 600, ""],
  [["stun:local.invalid"], [], "all", 600, ""],
  [
    ["stuns:local.invalid"],
    ["turn:local.invalid", "turns:local.invalid:443"],
    "all",
    600,
    "fixture TURN secret",
  ],
  [[], ["turn:local.invalid"], "relay", 60, "κλειδί-🔐"],
  [[], ["turns:local.invalid"], "relay", 3600, "x".repeat(200)],
]) {
  const config = {
    stunUrls: stun,
    iceTransportPolicy: policy,
    negotiationTimeoutMs: 8000,
    ...(turn.length
      ? { turn: { urls: turn, sharedSecret: secret, ttlSeconds: ttl } }
      : {}),
  };
  const environment = {
    CANTRIP_STUN_URLS: stun.join(","),
    CANTRIP_WEBRTC_ICE_TRANSPORT_POLICY: policy,
    ...(turn.length
      ? {
          CANTRIP_TURN_URLS: turn.join(","),
          CANTRIP_TURN_SHARED_SECRET: secret,
          CANTRIP_TURN_TTL_SECONDS: String(ttl),
        }
      : {}),
  };
  for (const owner of ["owner", "用户-🦀"])
    for (const now of [-1, 1794124800999, 1794124801000])
      cases.push({
        environment,
        owner,
        now,
        expected: createRemoteSurfaceWebRtcConfiguration(config, owner, now),
      });
}
console.log(JSON.stringify(cases));
