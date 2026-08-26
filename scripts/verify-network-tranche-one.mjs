import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

const migratedConsumers = [
  {
    path: "cantrip_app/src/components/terminal/terminal-view.tsx",
    required: ["openTerminalWorkerLink"],
  },
  {
    path: "cantrip_app/src/lib/browser-code-tunnel.ts",
    required: ["createBrowserCodeWorkerLinkSocket"],
  },
  {
    path: "cantrip_app/src/lib/desktop-code.ts",
    required: ["startDesktopTunnel"],
  },
  {
    path: "cantrip_app/src/lib/desktop-project-share.ts",
    required: ["startDesktopTunnel"],
  },
  {
    path: "cantrip_app/src/lib/desktop-chat-files.ts",
    required: ["startDesktopTunnel"],
  },
  {
    path: "cantrip_app/src/components/settings/tunnel-settings.tsx",
    required: ["startDesktopTunnel"],
  },
  {
    path: "cantrip_app/src/components/browser/browser-view.tsx",
    required: ["startDesktopTunnel", "useRemoteSurfaceWorkerLink"],
    forbidden: ["remoteSurfaceWebSocketUrl", "useRemoteSurfaceTransport"],
  },
  {
    path: "cantrip_app/src/lib/terminal-worker-link.ts",
    required: ["workerLinkManager", 'openStream(grant, "interactive")'],
  },
  {
    path: "cantrip_app/src/lib/tunnel-worker-link.ts",
    required: ["workerLinkManager", 'openStream(issued.grant, "stream")'],
  },
  {
    path: "cantrip_app/src/lib/browser-code-worker-link-socket.ts",
    required: ["openTunnelWorkerLink"],
  },
  {
    path: "cantrip_app/src/lib/remote-surface-worker-link.ts",
    required: [
      "workerLinkManager",
      'openStream(grant, "interactive")',
      'openStream(grant, "realtime")',
    ],
  },
  {
    path: "cantrip_worker/src/remote-surface-worker-link-adapter.ts",
    required: [
      "encodeWorkerLinkRemoteSurfaceChunk",
      "pendingInteractive",
      "pendingRealtime",
    ],
  },
  {
    path: "cantrip_worker/src/browser/browser-adapter.ts",
    required: ["publishState(attachmentId)", "captureFrame(attachmentId)"],
  },
];

const featureOwnedTopology = [
  "createDirectTerminalAttachment",
  "startDirectDesktopTerminal",
  "createDirectTunnelAttachment",
  "startDirectDesktopTunnel",
  "forceDesktopTunnelRelay",
  "terminalWebSocketUrl",
  "tunnelAttachmentWebSocketUrl",
  "RTCPeerConnection",
  "createWorkerLinkDirectTicket",
  "createWorkerLinkPeerSession",
  "openWorkerLinkLocalCarrier",
  "openWorkerLinkPeerCarrier",
  "openWorkerLinkRelayCarrier",
  "/api/worker-links/",
];

const platformRequirements = [
  {
    path: "cantrip_app/ios/App/App/Info.plist",
    required: ["NSLocalNetworkUsageDescription"],
  },
  {
    path: "cantrip_app/src-tauri/Info.plist",
    required: ["NSLocalNetworkUsageDescription"],
  },
];

const violations = [];
for (const consumer of migratedConsumers) {
  const content = await readFile(
    path.join(repositoryRoot, consumer.path),
    "utf8",
  );
  for (const required of consumer.required) {
    if (!content.includes(required)) {
      violations.push(`${consumer.path} must retain ${required}`);
    }
  }
  for (const identifier of featureOwnedTopology) {
    if (content.includes(identifier)) {
      violations.push(
        `${consumer.path} must not select topology through ${identifier}`,
      );
    }
  }
  for (const identifier of consumer.forbidden ?? []) {
    if (content.includes(identifier)) {
      violations.push(`${consumer.path} must not retain ${identifier}`);
    }
  }
}

for (const platform of platformRequirements) {
  const content = await readFile(
    path.join(repositoryRoot, platform.path),
    "utf8",
  );
  for (const required of platform.required) {
    if (!content.includes(required)) {
      violations.push(`${platform.path} must retain ${required}`);
    }
  }
}

const removedHelpers = ["cantrip_app/src/lib/desktop-terminal.ts"];
for (const removed of removedHelpers) {
  try {
    await access(path.join(repositoryRoot, removed));
    violations.push(`${removed} is an obsolete feature-owned topology helper`);
  } catch {
    // Expected: supported feature entry points use WorkerLink-facing boundaries.
  }
}

if (violations.length > 0) {
  console.error("Tranche One WorkerLink cutover violations remain:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log(
    "Renderer Terminal, tunnels, project shares, Code, and Browser Remote Surface inherit WorkerLink-owned LOCAL/LAN/WAN/RELAY topology",
  );
}
