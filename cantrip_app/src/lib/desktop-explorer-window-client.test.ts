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
        broker.postMessage({
          configuredAtMs: 123,
          launchId,
          type: "editor.configured",
        });
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
    let resolveConfigured!: (value: number) => void;
    const configured = new Promise<number>((resolve) => {
      resolveConfigured = resolve;
    });
    const client = new DesktopExplorerWindowClient(launchId, {
      onContext: resolveContext,
      onEditor: vi.fn(),
      onEditorConfigured: resolveConfigured,
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await expect(receivedContext).resolves.toEqual(context);
    await expect(configured).resolves.toBe(123);
    await expect(client.readFile()).resolves.toEqual(file);

    client.dispose();
    broker.close();
  });

  it("retries the launch handoff until the owning window listener is ready", async () => {
    const launchId = crypto.randomUUID();
    const context: DesktopExplorerWindowContext = {
      appearance: "dark",
      explorer: { id: "explorer-two" } as ExplorerSummary,
      path: "src/retry.ts",
      requestedAtMs: Date.now(),
    };
    let resolveContext!: (value: DesktopExplorerWindowContext) => void;
    const receivedContext = new Promise<DesktopExplorerWindowContext>(
      (resolve) => {
        resolveContext = resolve;
      },
    );
    const client = new DesktopExplorerWindowClient(launchId, {
      onContext: resolveContext,
      onEditor: vi.fn(),
      onEditorConfigured: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();

    await new Promise((resolve) => setTimeout(resolve, 150));
    const broker = new BroadcastChannel(
      desktopExplorerWindowChannelName(launchId),
    );
    broker.addEventListener("message", (event) => {
      const request = event.data as DesktopExplorerWindowRequest;
      if (request.type === "launch.request") {
        broker.postMessage({ context, launchId, type: "launch.ready" });
      }
    });

    await expect(receivedContext).resolves.toEqual(context);
    client.dispose();
    broker.close();
  });

  it("accepts a later file handoff without replaying duplicate context", async () => {
    const launchId = crypto.randomUUID();
    const broker = new BroadcastChannel(
      desktopExplorerWindowChannelName(launchId),
    );
    const initial: DesktopExplorerWindowContext = {
      appearance: "dark",
      explorer: { id: "explorer-warm" } as ExplorerSummary,
      path: ".cantrip-editor-prewarm",
      requestedAtMs: 1,
    };
    const active = {
      ...initial,
      path: "src/active.ts",
      requestedAtMs: 2,
    };
    broker.addEventListener("message", (event) => {
      const request = event.data as DesktopExplorerWindowRequest;
      if (request.type === "launch.request") {
        broker.postMessage({
          context: initial,
          launchId,
          type: "launch.ready",
        });
      }
    });
    const onContext = vi.fn();
    const client = new DesktopExplorerWindowClient(launchId, {
      onContext,
      onEditor: vi.fn(),
      onEditorConfigured: vi.fn(),
      onEditorError: vi.fn(),
      onLaunchError: vi.fn(),
    });
    client.start();
    await vi.waitFor(() => expect(onContext).toHaveBeenCalledOnce());

    broker.postMessage({ context: active, launchId, type: "launch.ready" });
    broker.postMessage({ context: active, launchId, type: "launch.ready" });
    await vi.waitFor(() => expect(onContext).toHaveBeenCalledTimes(2));
    expect(onContext).toHaveBeenLastCalledWith(active);

    client.dispose();
    broker.close();
  });
});
