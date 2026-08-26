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
    required: ["startDesktopTunnel"],
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
    "Terminal, tunnels, project shares, and Code retain WorkerLink-owned topology",
  );
}
