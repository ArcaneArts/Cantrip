import assert from "node:assert/strict";
import test from "node:test";

import {
  featureMatrix,
  physicalDeviceMatrix,
  topologyMatrix,
  runAcceptance,
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

test("a broken metadata marker cannot suppress behavioral suites", async () => {
  const calls = [];
  await assert.rejects(
    runAcceptance({
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
      },
      validateMatrix: async () => {
        calls.push(["metadata"]);
        throw new Error("renamed test title");
      },
      log: () => {},
    }),
    AggregateError,
  );
  for (const group of ["protocol", "app", "worker", "server"]) {
    assert.ok(
      calls.some(
        (args) => args.includes(`@cantrip/${group}`) && args.includes("vitest"),
      ),
    );
  }
  assert.ok(calls.some(([command]) => command === "cargo"));
  assert.deepEqual(calls.at(-1), ["metadata"]);
});

test("one behavioral failure still collects independent behavioral results", async () => {
  const calls = [];
  await assert.rejects(
    runAcceptance({
      runCommand: async (command, args) => {
        calls.push([command, ...args]);
        if (args.includes("@cantrip/app") && args.includes("vitest"))
          throw new Error("app regression");
      },
      validateMatrix: async () => ({
        topologyCases: 15,
        featureCases: 15,
        physicalDeviceDisclosures: 3,
      }),
      log: () => {},
    }),
    AggregateError,
  );
  assert.ok(
    calls.some(
      (args) => args.includes("@cantrip/server") && args.includes("vitest"),
    ),
  );
  assert.ok(calls.some(([command]) => command === "cargo"));
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
