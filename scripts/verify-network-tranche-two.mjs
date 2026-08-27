import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  combineApplicationSources,
  readApplicationSourceCorpus,
} from "./application-source-corpus.mjs";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const read = (relativePath) =>
  readFile(path.join(repositoryRoot, relativePath), "utf8");
const readApplication = async () =>
  combineApplicationSources(await readApplicationSourceCorpus(repositoryRoot));

const supportedConsumers = [
  {
    path: "cantrip_app/src/components/terminal/terminal-view.tsx",
    required: ["openTerminalWorkerLink"],
  },
  {
    path: "cantrip_app/src/components/browser/browser-view.tsx",
    required: ["useRemoteSurfaceWorkerLink"],
  },
  {
    path: "cantrip_app/src/components/remote-desktop/managed-remote-desktop-view.tsx",
    required: ["useRemoteSurfaceWorkerLink", "activeRoutes"],
  },
  {
    path: "cantrip_app/src/lib/browser-code-tunnel.ts",
    required: ["createBrowserCodeWorkerLinkSocket"],
  },
  {
    path: "cantrip_app/src/lib/desktop-tunnel.ts",
    required: ["startDesktopTunnelWorkerLinkForward"],
  },
  {
    path: "cantrip_app/src/lib/worker-observation-client.ts",
    required: ["openEventSubscription(grant)"],
  },
];

const forbiddenConsumerTopology = [
  "RemoteSurfaceWebRtcClient",
  "createDirectTerminalAttachment",
  "createDirectTunnelAttachment",
  "remoteSurfaceWebSocketUrl",
  "startDirectDesktopTunnel",
  "terminalWebSocketUrl",
  "useRemoteSurfaceTransport",
];

const removedClientFiles = [
  "cantrip_app/src/lib/remote-surface-webrtc.test.ts",
  "cantrip_app/src/lib/remote-surface-webrtc.ts",
  "cantrip_app/src/lib/use-remote-surface-transport.test.ts",
  "cantrip_app/src/lib/use-remote-surface-transport.ts",
];

const compatibilityRoutes = [
  "/api/remote-surfaces/:surfaceId/connect",
  "/api/terminals/:terminalId/direct",
  "/api/terminals/:terminalId/connect",
  "/api/tunnel-attachments/:attachmentId/direct",
  "/api/tunnel-attachments/:attachmentId/direct-activate",
  "/api/tunnel-attachments/:attachmentId/connect",
];

const violations = [];
for (const consumer of supportedConsumers) {
  const content = await read(consumer.path);
  for (const marker of consumer.required) {
    if (!content.includes(marker)) {
      violations.push(`${consumer.path} must retain ${marker}`);
    }
  }
  for (const marker of forbiddenConsumerTopology) {
    if (content.includes(marker)) {
      violations.push(
        `${consumer.path} must not select topology via ${marker}`,
      );
    }
  }
}

for (const removed of removedClientFiles) {
  try {
    await access(path.join(repositoryRoot, removed));
    violations.push(`${removed} is an obsolete feature-owned client transport`);
  } catch {
    // Expected: supported Remote Surfaces use the shared WorkerLink adapter.
  }
}

const [
  api,
  desktopTunnel,
  server,
  compatibility,
  metrics,
  protocol,
  network,
  acceptance,
  progress,
  packageManifest,
] = await Promise.all([
  read("cantrip_app/src/lib/api.ts"),
  read("cantrip_app/src/lib/desktop-tunnel.ts"),
  readApplication(),
  read("cantrip_server/src/operations/legacy-feature-transports.ts"),
  read("cantrip_server/src/operations/metrics.ts"),
  read("packages/protocol/src/index.ts"),
  read("docs/NETWORK.md"),
  read("docs/NETWORK_ACCEPTANCE.md"),
  read("docs/NETWORK_PROGRESS.md"),
  read("package.json"),
]);

for (const marker of [
  "createDirectTerminalAttachment",
  "createDirectTunnelAttachment",
  "activateDirectTunnelAttachment",
  "remoteSurfaceWebSocketUrl",
  "terminalWebSocketUrl",
]) {
  if (api.includes(marker)) {
    violations.push(`cantrip_app/src/lib/api.ts retains unused ${marker}`);
  }
}
for (const marker of [
  "Tranche One and Tranche Two stabilized",
  "NETWORK_ACCEPTANCE.md",
  "pnpm network:acceptance",
]) {
  if (!network.includes(marker)) {
    violations.push(
      `network architecture is missing final status marker ${marker}`,
    );
  }
}
for (const marker of [
  "Tauri and worker on the same machine",
  "Ordinary LAN, cellular, and restrictive public NAT",
  "Physical validation",
  "Not run",
]) {
  if (!acceptance.includes(marker)) {
    violations.push(`network acceptance record is missing ${marker}`);
  }
}
for (const marker of [
  "Tranche Two: Stabilized",
  "T2.11 — Full acceptance and stabilization gate",
  "No Tranche Two implementation pass remains",
]) {
  if (!progress.includes(marker)) {
    violations.push(`network progress ledger is missing ${marker}`);
  }
}
for (const marker of ["network:acceptance", "network:acceptance:check"]) {
  if (!packageManifest.includes(marker)) {
    violations.push(`package scripts are missing ${marker}`);
  }
}
if (desktopTunnel.includes("startDirectDesktopTunnel")) {
  violations.push(
    "cantrip_app/src/lib/desktop-tunnel.ts retains unused startDirectDesktopTunnel",
  );
}
for (const marker of ["forceDesktopTunnelRelay", "deleteDirectAttachment"]) {
  if (!desktopTunnel.includes(marker)) {
    violations.push(
      `cantrip_app/src/lib/desktop-tunnel.ts must retain ${marker} while already-running legacy forwards can exist`,
    );
  }
}

for (const route of compatibilityRoutes) {
  if (!server.includes(route) || !compatibility.includes(route)) {
    violations.push(
      `compatibility endpoint is not retained and classified: ${route}`,
    );
  }
}
for (const marker of [
  'reply.header("deprecation"',
  'reply.header("link"',
  "recordLegacyFeatureTransport",
  "network.compatibility-endpoint.requested",
]) {
  if (!server.includes(marker)) {
    violations.push(`server compatibility boundary is missing ${marker}`);
  }
}
for (const marker of [
  "cantrip_legacy_feature_transport_requests_total",
  "legacyFeatureTransportEndpoints",
]) {
  if (!metrics.includes(marker)) {
    violations.push(`compatibility telemetry is missing ${marker}`);
  }
}
for (const marker of ["legacyFeatureTransports", "workerLinkRelay"]) {
  if (!protocol.includes(marker)) {
    violations.push(`server operational protocol is missing ${marker}`);
  }
}
for (const marker of [
  "2026-08-27",
  "2026-11-25",
  "two stable releases",
  "30 consecutive days",
  "Sunset",
]) {
  if (!network.includes(marker)) {
    violations.push(`network compatibility policy is missing ${marker}`);
  }
}

if (violations.length > 0) {
  console.error("Tranche Two network consolidation violations remain:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    "Supported features use WorkerLink; legacy feature transports are isolated behind a measured compatibility boundary",
  );
}
