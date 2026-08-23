import type { ExplorerFile, ExplorerSummary } from "@cantrip/protocol";
import { describe, expect, it, vi } from "vitest";

import { DesktopExplorerWindowClient } from "./desktop-explorer-window-client";
import {
  desktopExplorerWindowChannelName,
  type DesktopExplorerWindowContext,
  type DesktopExplorerWindowRequest,
} from "./desktop-explorer-window-protocol";

describe("DesktopExplorerWindowClient", () => {
  it("receives launch state and file data from the owning main window", async () => {
    const launchId = crypto.randomUUID();
    const broker = new BroadcastChannel(
      desktopExplorerWindowChannelName(launchId),
    );
    const context: DesktopExplorerWindowContext = {
      appearance: "dark",
      explorer: { id: "explorer-one" } as ExplorerSummary,
      path: "src/index.ts",
      requestedAtMs: Date.now(),
    };
    const file = {
      content: "export {};",
      path: context.path,
      version: "version-one",
    } as ExplorerFile;
    broker.addEventListener("message", (event) => {
      const request = event.data as DesktopExplorerWindowRequest;
      if (request.type === "launch.request") {
        broker.postMessage({ context, launchId, type: "launch.ready" });
      } else if (request.type === "file.read") {
        broker.postMessage({
          file,
          launchId,
          requestId: request.requestId,
          type: "file.result",
        });
      }
    });

    let resolveContext!: (value: DesktopExplorerWindowContext) => void;
    const receivedContext = new Promise<DesktopExplorerWindowContext>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const client = new DesktopExplorerWindowClient(launchId, {
      onContext: resolveContext,
      onEditor: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(receivedContext).resolves.toEqual(context);
    await expect(client.readFile()).resolves.toEqual(file);

    client.dispose();
    broker.close();
  });
});
