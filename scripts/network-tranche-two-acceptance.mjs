import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const evidence = (filePath, ...markers) => ({ filePath, markers });

export const topologyMatrix = [
  {
    id: "same-machine-local",
    expected: "LOCAL",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        'id: "same-machine-local"',
      ),
      evidence(
        "cantrip_app/src/lib/worker-link-carriers.test.ts",
        "activates and renews LOCAL after the broker proves its identity",
      ),
      evidence(
        "cantrip_server/test/direct-attachment-coordinator.test.ts",
        "keeps an activated WorkerLink capability alive across repeated renewals",
      ),
      evidence(
        "cantrip_server/test/project-placement-api.test.ts",
        "activates an exact LOCAL capability before accepting lease heartbeats",
      ),
    ],
  },
  {
    id: "ordinary-lan",
    expected: "LAN",
    evidence: [
      evidence("cantrip_app/src/lib/worker-link.test.ts", 'id: "same-lan"'),
      evidence(
        "packages/protocol/test/worker-link.test.ts",
        "192.168.1.20",
        '"lan"',
      ),
    ],
  },
  {
    id: "tailscale-wan",
    expected: "WAN",
    evidence: [
      evidence(
        "packages/protocol/test/worker-link.test.ts",
        'workerLinkPeerInterfaceIsVpn("tailscale0")',
      ),
    ],
  },
  {
    id: "zerotier-wan",
    expected: "WAN",
    evidence: [
      evidence(
        "packages/protocol/test/worker-link.test.ts",
        'workerLinkPeerInterfaceIsVpn("zerotier-one")',
      ),
    ],
  },
  {
    id: "public-stun-wan",
    expected: "WAN",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        'id: "public-stun-wan"',
      ),
      evidence(
        "packages/protocol/test/worker-link.test.ts",
        'candidate("1.1.1.1", "srflx")',
        "stun:stun.cloudflare.com:3478",
      ),
    ],
  },
  {
    id: "udp-blocked-relay",
    expected: "RELAY",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        'id: "udp-blocked-relay"',
      ),
    ],
  },
  {
    id: "listener-blocked-relay",
    expected: "RELAY",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        'id: "listener-blocked-relay"',
      ),
    ],
  },
  {
    id: "cellular-to-wifi",
    expected: "reprobe -> LAN",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "moves cellular to Wi-Fi to cellular through LAN, WAN, then RELAY",
        'phase = "wifi"',
      ),
    ],
  },
  {
    id: "wifi-to-cellular",
    expected: "reprobe -> WAN -> RELAY",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "moves cellular to Wi-Fi to cellular through LAN, WAN, then RELAY",
        'phase = "blocked"',
      ),
    ],
  },
  {
    id: "different-server-replicas",
    expected: "identical semantics",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-service.test.ts",
        "resolves and mutates a session from any coordinated server instance",
      ),
      evidence(
        "cantrip_server/test/shared-relay-coordination.test.ts",
        "routes commands and binary frames between server instances",
      ),
    ],
  },
  {
    id: "expired-grant",
    expected: "revoke and reconnect safely",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "expires grants and sessions and rolls back failed installations",
      ),
    ],
  },
  {
    id: "logout",
    expected: "exact account-session revocation",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-service.test.ts",
        "broadcasts account-session revocation to the authority instance",
      ),
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "revokes live links when the authenticated client identity changes",
      ),
    ],
  },
  {
    id: "resource-deletion",
    expected: "exact grant revocation",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "revokes one exact tunnel attachment without retiring sibling grants",
      ),
    ],
  },
  {
    id: "worker-restart",
    expected: "generation-fenced reconnect",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "fences account sessions, resources, worker loss, and process replacement",
      ),
    ],
  },
  {
    id: "server-generation-change",
    expected: "stale authority rejected and streams reopened",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "adopts a renewed route generation and reconnects without stale authority",
      ),
      evidence(
        "cantrip_worker/src/worker-link-webrtc.test.ts",
        "fails closed when the peer identity handshake is stale",
      ),
    ],
  },
];

export const featureMatrix = [
  {
    id: "terminal",
    evidence: [
      evidence(
        "cantrip_app/src/lib/terminal-worker-link.test.ts",
        "uses the same grant and stream boundary when the manager selects %s",
      ),
      evidence(
        "cantrip_worker/src/terminal-worker-link-adapter.test.ts",
        "preserves replay-before-ready ordering and resumes output on credit",
      ),
    ],
  },
  {
    id: "code-http-websocket-hmr",
    evidence: [
      evidence(
        "cantrip_app/src/lib/browser-code-tunnel.test.ts",
        "retains the browser transport registry across HMR state reuse",
        "keeps the request stream open until the proxied HTTP response closes",
        "accepts WebSocket requests from descendants of the exact bound frame",
        "reconnects a transient relay close without replacing the retained session",
      ),
      evidence(
        "cantrip_app/src/lib/browser-code-worker-link-socket.test.ts",
        "adapts a %s WorkerLink stream to the existing Code socket boundary",
      ),
    ],
  },
  {
    id: "code-explorer-lifecycle",
    evidence: [
      evidence(
        "cantrip_app/src/components/app/sidebar-explorer-controller.test.ts",
        "does not provision a speculative spare while one sidebar Explorer owns preview navigation",
      ),
      evidence(
        "cantrip_app/src/components/explorer/persistent-explorer-code-ownership.test.tsx",
        "promotes a sidebar preview under the same Explorer identity without reconnecting Code",
      ),
      evidence(
        "cantrip_app/src/components/explorer/explorer-code-editor-lifecycle.test.tsx",
        "retries file open after the bridge reconnects without replacing the attachment",
        "caps automatic attachment replacement until the workbench is ready",
      ),
    ],
  },
  {
    id: "generic-tcp",
    evidence: [
      evidence(
        "cantrip_app/src/lib/desktop-tunnel-worker-link.test.ts",
        "walks LAN to WAN to RELAY without rebinding the native listener",
        "reopens only the WorkerLink stream after a route failure",
      ),
      evidence(
        "cantrip_worker/src/tunnel-worker-link-adapter.test.ts",
        "waits for fresh outer credit after a nested frame is rejected",
      ),
      evidence(
        "cantrip_worker/test/tunnel-tcp-adapter.test.ts",
        "pauses destination reads until the source grants more byte credit",
        "split a queued read at the exact credit boundary instead of deadlocking",
      ),
    ],
  },
  {
    id: "browser-remote-surface",
    evidence: [
      evidence(
        "cantrip_worker/src/remote-surface-worker-link-adapter.test.ts",
        "isolates reliable control from disposable frame and cursor output",
      ),
      evidence(
        "cantrip_app/src/components/browser/browser-view.test.ts",
        "keeps the browser surface current under interactive frame bursts",
      ),
    ],
  },
  {
    id: "remote-desktop",
    evidence: [
      evidence(
        "cantrip_worker/src/remote-surface-worker-link-adapter.test.ts",
        "binds Remote Desktop attachments through the same lane adapter",
        "finishes a large realtime frame across credit returns",
      ),
      evidence(
        "cantrip_app/src/components/remote-desktop/managed-remote-desktop-view.test.ts",
        "reports truthful per-lane WorkerLink routes",
      ),
    ],
  },
  {
    id: "provisional-observations",
    evidence: [
      evidence(
        "cantrip_worker/src/worker-observation-worker-link-adapter.test.ts",
        "fans provisional chat and filesystem events to exact topics",
        "never publishes final messages or durable turn outcomes",
      ),
      evidence(
        "cantrip_app/src/lib/worker-observation-client.test.ts",
        "discards provisional state and reconnects after a continuity gap",
        "keeps the WorkerLink alive while moving observations to a promoted route",
      ),
    ],
  },
  {
    id: "multiple-clients-per-worker",
    evidence: [
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "isolates multiple clients per worker and multiple workers per client",
      ),
    ],
  },
  {
    id: "multiple-workers-per-client",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "keeps simultaneous workers isolated beneath one client manager",
      ),
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "isolates multiple clients per worker and multiple workers per client",
      ),
    ],
  },
  {
    id: "mixed-routes",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "promotes new streams to LAN while preserving RELAY streams and standby",
      ),
    ],
  },
  {
    id: "stale-route-generation",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "multiplexes reliable streams and ignores stale route frames",
      ),
      evidence(
        "cantrip_server/test/worker-link-relay.test.ts",
        "fails closed on stale generations and closes worker channels on disconnect",
      ),
    ],
  },
  {
    id: "relay-only",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link.test.ts",
        "honors LOCAL-only and RELAY-only policy without rewriting authority",
      ),
      evidence(
        "cantrip_server/test/worker-link-coordinator.test.ts",
        "advertises direct routes only when policy permits them",
      ),
    ],
  },
  {
    id: "browser-capacitor-peer-carrier",
    evidence: [
      evidence(
        "cantrip_app/src/lib/worker-link-peer-carrier.test.ts",
        "authenticates the exact peer and carries the shared envelope by lane",
      ),
      evidence(
        "cantrip_app/src/lib/worker-link.ts",
        "CapacitorNetwork",
        "CapacitorApp",
        "openWorkerLinkPeerCarrier",
      ),
    ],
  },
  {
    id: "network-map-route-truth",
    evidence: [
      evidence(
        "cantrip_app/src/components/settings/worker-network-graph.test.tsx",
        "renders truthful mixed route segments per channel",
        "provides complete worker route details without private connection data",
      ),
    ],
  },
];

export const physicalDeviceMatrix = [
  {
    id: "ios-capacitor-physical-webrtc",
    status: "not-run",
    reason: "No physical iOS device is attached to this repository runner.",
  },
  {
    id: "android-capacitor-physical-webrtc",
    status: "not-run",
    reason: "No physical Android device is attached to this repository runner.",
  },
  {
    id: "multi-device-lan-public-nat",
    status: "not-run",
    reason:
      "The runner has no independent LAN peer, cellular path, or configurable restrictive NAT.",
  },
];

export const targetedTests = {
  protocol: ["test/worker-link.test.ts"],
  app: [
    "src/lib/worker-link.test.ts",
    "src/lib/worker-link-carriers.test.ts",
    "src/lib/worker-link-peer-carrier.test.ts",
    "src/lib/terminal-worker-link.test.ts",
    "src/lib/tunnel-worker-link.test.ts",
    "src/lib/browser-code-worker-link-socket.test.ts",
    "src/lib/browser-code-tunnel.test.ts",
    "src/lib/desktop-tunnel-worker-link.test.ts",
    "src/lib/remote-surface-worker-link.test.ts",
    "src/lib/worker-observation-client.test.ts",
    "src/components/app/sidebar-explorer-controller.test.ts",
    "src/components/browser/browser-view.test.ts",
    "src/components/explorer/explorer-code-editor-lifecycle.test.tsx",
    "src/components/explorer/persistent-explorer-code-ownership.test.tsx",
    "src/components/remote-desktop/managed-remote-desktop-view.test.ts",
    "src/components/settings/worker-network-graph.test.tsx",
  ],
  worker: [
    "src/worker-link-gateway.test.ts",
    "src/worker-link-peer-gateway.test.ts",
    "src/worker-link-webrtc.test.ts",
    "src/terminal-worker-link-adapter.test.ts",
    "src/tunnel-worker-link-adapter.test.ts",
    "test/tunnel-tcp-adapter.test.ts",
    "src/remote-surface-worker-link-adapter.test.ts",
    "src/worker-observation-worker-link-adapter.test.ts",
  ],
  server: [
    "test/direct-attachment-coordinator.test.ts",
    "test/project-placement-api.test.ts",
    "test/worker-link-coordinator.test.ts",
    "test/worker-link-service.test.ts",
    "test/worker-link-relay.test.ts",
    "test/shared-relay-coordination.test.ts",
  ],
};

const packageTestRoots = {
  protocol: "packages/protocol/",
  app: "cantrip_app/",
  worker: "cantrip_worker/",
  server: "cantrip_server/",
};

export async function validateAcceptanceMatrix() {
  const entries = [...topologyMatrix, ...featureMatrix];
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error(
      "The Tranche Two acceptance matrix contains duplicate IDs.",
    );
  }

  const targeted = new Set(
    Object.entries(targetedTests).flatMap(([group, files]) =>
      files.map((filePath) => `${packageTestRoots[group]}${filePath}`),
    ),
  );
  const cache = new Map();
  for (const entry of entries) {
    if (entry.evidence.length === 0) {
      throw new Error(`${entry.id} has no executable or source evidence.`);
    }
    for (const item of entry.evidence) {
      let content = cache.get(item.filePath);
      if (content === undefined) {
        content = await readFile(
          path.join(repositoryRoot, item.filePath),
          "utf8",
        );
        cache.set(item.filePath, content);
      }
      for (const marker of item.markers) {
        if (!content.includes(marker)) {
          throw new Error(
            `${entry.id} is missing ${marker} in ${item.filePath}.`,
          );
        }
      }
      if (
        /\.test\.[cm]?[jt]sx?$/u.test(item.filePath) &&
        !targeted.has(item.filePath)
      ) {
        throw new Error(
          `${entry.id} cites ${item.filePath}, but the acceptance runner does not execute it.`,
        );
      }
    }
  }

  if (physicalDeviceMatrix.some((entry) => entry.status !== "not-run")) {
    throw new Error(
      "Physical-device results must be recorded from an actual run, never inferred by this deterministic harness.",
    );
  }
  return {
    featureCases: featureMatrix.length,
    physicalDeviceDisclosures: physicalDeviceMatrix.length,
    topologyCases: topologyMatrix.length,
  };
}

async function run(command, args) {
  await new Promise((resolve, reject) => {
    const executable =
      process.platform === "win32" && command === "pnpm" ? "pnpm.cmd" : command;
    const child = spawn(executable, args, {
      cwd: repositoryRoot,
      env: { ...process.env, FORCE_COLOR: "0" },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} failed with ${signal ?? `exit ${code}`}.`,
          ),
        );
      }
    });
  });
}

async function runAcceptance() {
  const summary = await validateAcceptanceMatrix();
  console.log(
    `Validated ${summary.topologyCases} topology cases, ${summary.featureCases} feature cases, and ${summary.physicalDeviceDisclosures} honest physical-device disclosures.`,
  );
  if (process.argv.includes("--check")) return;

  for (const packageName of [
    "@cantrip/version",
    "@cantrip/logging",
    "@cantrip/protocol",
    "@cantrip/crypto",
    "@cantrip/glitch",
  ]) {
    await run("pnpm", ["--filter", packageName, "build"]);
  }
  await run("pnpm", ["verify:network-tranche-one"]);
  await run("pnpm", ["verify:network-tranche-two"]);

  for (const [group, files] of Object.entries(targetedTests)) {
    const packageName = `@cantrip/${group}`;
    await run("pnpm", [
      "--filter",
      packageName,
      "exec",
      "vitest",
      "run",
      "--maxWorkers=2",
      ...files,
    ]);
  }
  await run("cargo", [
    "test",
    "--locked",
    "--manifest-path",
    "cantrip_app/src-tauri/Cargo.toml",
    "worker_link",
  ]);

  console.log("Tranche Two deterministic acceptance matrix passed.");
}

if (path.resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  await runAcceptance();
}
