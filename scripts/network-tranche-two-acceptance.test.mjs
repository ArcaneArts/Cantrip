import assert from "node:assert/strict";
import test from "node:test";

import {
  featureMatrix,
  physicalDeviceMatrix,
  topologyMatrix,
  validateAcceptanceMatrix,
} from "./network-tranche-two-acceptance.mjs";

test("Tranche Two topology matrix names every required deterministic case", async () => {
  assert.deepEqual(topologyMatrix.map((entry) => entry.id).sort(), [
    "cellular-to-wifi",
    "different-server-replicas",
    "expired-grant",
    "listener-blocked-relay",
    "logout",
    "ordinary-lan",
    "public-stun-wan",
    "resource-deletion",
    "same-machine-local",
    "server-generation-change",
    "tailscale-wan",
    "udp-blocked-relay",
    "wifi-to-cellular",
    "worker-restart",
    "zerotier-wan",
  ]);
  await assert.doesNotReject(validateAcceptanceMatrix());
});

test("Tranche Two feature matrix covers every migrated fabric consumer", () => {
  assert.deepEqual(featureMatrix.map((entry) => entry.id).sort(), [
    "browser-capacitor-peer-carrier",
    "browser-remote-surface",
    "code-explorer-lifecycle",
    "code-http-websocket-hmr",
    "generic-tcp",
    "mixed-routes",
    "multiple-clients-per-worker",
    "multiple-workers-per-client",
    "network-map-route-truth",
    "provisional-observations",
    "relay-only",
    "remote-desktop",
    "stale-route-generation",
    "terminal",
    "worker-link-byte-window-drain",
  ]);
});

test("physical-device validation remains explicitly undisclosed by automation", () => {
  assert.equal(physicalDeviceMatrix.length, 3);
  assert.ok(
    physicalDeviceMatrix.every(
      (entry) => entry.status === "not-run" && entry.reason.length > 0,
    ),
  );
});
