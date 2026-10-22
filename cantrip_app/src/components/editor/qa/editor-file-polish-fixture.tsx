import { createRoot } from "react-dom/client";
import { DesktopExplorerFileWindow } from "@/components/explorer/desktop-explorer-file-window";
import {
  desktopExplorerWindowChannelName,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowRequest,
} from "@/lib/desktop-explorer-window-protocol";
import "@/index.css";

// Exercise the actual desktop file component/client with a disposable HTTP file owner.
const path = new URLSearchParams(location.search).get("file") ?? "LICENSE";
const launchId = crypto.randomUUID();
const channel = new BroadcastChannel(
  desktopExplorerWindowChannelName(launchId),
);
const context = {
  serverId: "qa-server",
  ownerId: "qa-owner",
  appearance: "dark",
  path,
  requestedAtMs: Date.now(),
  projectTitle: "File view QA",
  explorer: {
    id: "qa-explorer",
    projectId: "00000000-0000-4000-8000-000000000001",
    worktreeId: "00000000-0000-4000-8000-000000000002",
    activeWorkerId: "qa-worker",
  },
} as DesktopExplorerWindowContext;
channel.onmessage = (event: MessageEvent<DesktopExplorerWindowRequest>) => {
  const request = event.data;
  if (request.type === "launch.request") {
    channel.postMessage({ type: "launch.ready", launchId, context });
    return;
  }
  if (request.type !== "file.read" && request.type !== "file.save") return;
  void (async () => {
    const saved = request.type === "file.save";
    const response = await fetch(
      `/__qa/files/${encodeURIComponent(path)}`,
      saved
        ? {
            method: "PUT",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              content: request.content,
              version: request.version,
            }),
          }
        : undefined,
    );
    if (!response.ok) throw new Error("Fixture file operation failed");
    const result = (await response.json()) as {
      version: string;
      content?: string;
    };
    channel.postMessage({
      type: "file.result",
      launchId,
      requestId: request.requestId,
      file: {
        path,
        content: saved ? request.content : result.content,
        version: result.version,
        markdown: path.endsWith(".md"),
      },
    });
  })().catch((error: unknown) =>
    channel.postMessage({
      type: "request.failed",
      launchId,
      requestId: request.requestId,
      error: String(error),
    }),
  );
};
addEventListener("pagehide", () => channel.close(), { once: true });
createRoot(document.getElementById("root")!).render(
  <DesktopExplorerFileWindow initialPath={path} launchId={launchId} />,
);
