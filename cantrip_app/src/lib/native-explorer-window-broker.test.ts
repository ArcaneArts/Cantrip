import type { ExplorerSummary } from "@cantrip/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  tauri: false,
  session: { serverId: "server-one", user: { id: "owner-one" } },
  identityListeners: new Set<() => void>(),
}));
const api = vi.hoisted(() => ({
  getExplorerFile: vi.fn(),
  loadExplorerMedia: vi.fn(),
  saveExplorerFile: vi.fn(),
  createProtectedExplorerCodeSessionAttachment: vi.fn(),
}));
vi.mock("@/lib/api", () => api);
vi.mock("@/lib/desktop-code", () => ({}));
vi.mock("@/lib/client-session", () => ({
  getClientSession: () => state.session,
  onClientSessionIdentityChanged: (listener: () => void) => {
    state.identityListeners.add(listener);
    return () => state.identityListeners.delete(listener);
  },
}));
vi.mock("@tauri-apps/api/core", async (original) => ({
  ...(await original<typeof import("@tauri-apps/api/core")>()),
  isTauri: () => state.tauri,
}));
import { createDesktopExplorerWindowBroker } from "./desktop-explorer-window-broker";
import * as brokers from "./desktop-explorer-window-broker";
import { DesktopExplorerWindowClient } from "./desktop-explorer-window-client";
import {
  desktopExplorerWindowChannelName,
  type DesktopExplorerWindowContext,
} from "./desktop-explorer-window-protocol";

const explorer = {
  id: "explorer-one",
  projectId: "project-one",
  worktreeId: "worktree-one",
  activeWorkerId: "worker-one",
} as ExplorerSummary;
const cleanups: (() => void | Promise<void>)[] = [];
beforeEach(() => {
  vi.clearAllMocks();
  state.tauri = false;
  state.session = { serverId: "server-one", user: { id: "owner-one" } };
  state.identityListeners.clear();
  api.getExplorerFile.mockImplementation(async (_id, path) => ({
    content: "original",
    path,
    version: "one",
  }));
  api.saveExplorerFile.mockImplementation(async (_id, input) => ({
    ...input,
    version: "two",
  }));
});
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
});

async function connect() {
  const broker = createDesktopExplorerWindowBroker({
    appearance: "dark",
    explorer,
    path: "src/main.ts",
  });
  cleanups.push(() => broker.dispose());
  let context: DesktopExplorerWindowContext | undefined;
  const callbacks = {
    onContext: (value: DesktopExplorerWindowContext) => {
      context = value;
    },
    onEditorEndpoint: vi.fn(),
    onEditorReady: vi.fn(),
    onEditorError: vi.fn(),
    onLaunchError: vi.fn(),
    onVsCodeLaunch: vi.fn(),
    onContextRevoked: vi.fn(),
  };
  const client = new DesktopExplorerWindowClient(broker.launchId, callbacks);
  cleanups.push(() => client.dispose());
  client.start();
  await vi.waitFor(() => expect(context).toBeDefined());
  return { broker, client, callbacks, context: context! };
}

describe("native desktop file broker", () => {
  it.each(["server", "account"] as const)(
    "revokes the popup and rejects pending reads when its %s changes",
    async (scope) => {
      let finish!: (value: {
        content: string;
        path: string;
        version: string;
      }) => void;
      api.getExplorerFile.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      const { broker, client, callbacks } = await connect();
      const pending = client.readFile();
      const rejected = expect(pending).rejects.toThrow("closed");
      await vi.waitFor(() =>
        expect(api.getExplorerFile).toHaveBeenCalledTimes(1),
      );
      state.session =
        scope === "server"
          ? { serverId: "server-two", user: { id: "owner-one" } }
          : { serverId: "server-one", user: { id: "owner-two" } };
      for (const listener of [...state.identityListeners]) listener();
      await rejected;
      expect(callbacks.onContextRevoked).toHaveBeenCalledWith(
        expect.stringContaining("account changed"),
      );
      expect(broker.failed).toBe(true);
      finish({
        content: "late private response",
        path: "src/main.ts",
        version: "one",
      });
      await expect(client.readFile()).rejects.toThrow("closed");
      expect(state.identityListeners.size).toBe(0);
    },
  );

  it("keeps the native broker alive when session refresh retains its account and server", async () => {
    const { client, callbacks, broker } = await connect();
    state.session = { serverId: "server-one", user: { id: "owner-one" } };
    for (const listener of state.identityListeners) listener();
    await expect(client.readFile()).resolves.toMatchObject({
      content: "original",
    });
    expect(callbacks.onContextRevoked).not.toHaveBeenCalled();
    expect(broker.failed).toBe(false);
  });
  it("creates and retires a legacy broker only after an explicit VS Code request", async () => {
    state.tauri = true;
    const dispose = vi.fn().mockResolvedValue(undefined);
    const launch = vi
      .spyOn(brokers, "createDesktopExplorerCodeWindowBroker")
      .mockReturnValue({
        launchId: "explicit-code-launch",
        ready: Promise.resolve(),
        failed: false,
        dispose,
        openFile: vi.fn(),
      });
    try {
      const { broker, client, callbacks } = await connect();
      expect(launch).not.toHaveBeenCalled();
      client.openInVsCode();
      await vi.waitFor(() =>
        expect(callbacks.onVsCodeLaunch).toHaveBeenCalledWith(
          "explicit-code-launch",
          expect.objectContaining({ path: "src/main.ts", explorer }),
        ),
      );
      expect(launch).toHaveBeenCalledOnce();
      await broker.dispose();
      expect(dispose).toHaveBeenCalledOnce();
    } finally {
      launch.mockRestore();
    }
  });
  it("hands a browser window its own authenticated Code route without a main-window workbench", async () => {
    const launch = vi.spyOn(brokers, "createDesktopExplorerCodeWindowBroker");
    try {
      const { broker, client, callbacks } = await connect();
      client.openInVsCode();
      await vi.waitFor(() =>
        expect(callbacks.onVsCodeLaunch).toHaveBeenCalledWith(
          broker.launchId,
          expect.objectContaining({ editor: "vscode", path: "src/main.ts" }),
        ),
      );
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
    }
  });
  it("opens, reads, and revision-saves through existing file APIs without creating a workbench", async () => {
    const { broker, client, callbacks, context } = await connect();
    await broker.ready;
    expect(context.editor).toBe("native");
    expect(context.serverId).toBe("server-one");
    expect(context.ownerId).toBe("owner-one");
    expect(await client.readFile()).toMatchObject({
      content: "original",
      path: "src/main.ts",
    });
    expect(await client.saveFile("changed", "one")).toMatchObject({
      content: "changed",
      version: "two",
    });
    expect(api.saveExplorerFile).toHaveBeenCalledWith(
      explorer.id,
      {
        content: "changed",
        version: "one",
        path: "src/main.ts",
      },
      {
        workerId: explorer.activeWorkerId,
        projectId: explorer.projectId,
        worktreeId: explorer.worktreeId,
      },
    );
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
    expect(callbacks.onEditorEndpoint).not.toHaveBeenCalled();
  });
  it("routes a new path after the client receives its exact context", async () => {
    const { broker, client } = await connect();
    await broker.openFile("src/next.py");
    await vi.waitFor(async () => {
      expect((await client.readFile()).path).toBe("src/next.py");
    });
    expect(
      api.createProtectedExplorerCodeSessionAttachment,
    ).not.toHaveBeenCalled();
  });
  it("rejects an old view's queued save instead of writing it to a new path", async () => {
    const { broker, context } = await connect();
    const channel = new BroadcastChannel(
      desktopExplorerWindowChannelName(broker.launchId),
    );
    cleanups.push(() => channel.close());
    const responses: unknown[] = [];
    channel.addEventListener("message", (event) => responses.push(event.data));
    await broker.openFile("src/next.py");
    channel.postMessage({
      type: "file.save",
      launchId: broker.launchId,
      requestId: "stale-save",
      path: context.path,
      requestedAtMs: context.requestedAtMs,
      content: "old draft",
      version: "one",
    });
    await vi.waitFor(() =>
      expect(responses).toContainEqual(
        expect.objectContaining({
          requestId: "stale-save",
          type: "request.failed",
          error: expect.stringContaining("previous editor view"),
        }),
      ),
    );
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it("rejects operations after an account change", async () => {
    const { client } = await connect();
    state.session = { serverId: "server-one", user: { id: "other-owner" } };
    await expect(client.saveFile("private draft", "one")).rejects.toThrow(
      "account changed",
    );
    expect(api.saveExplorerFile).not.toHaveBeenCalled();
  });
  it("returns actual conflict failures without changing file or client draft data", async () => {
    const { client } = await connect();
    api.saveExplorerFile.mockRejectedValue(
      new Error("File changed externally"),
    );
    await expect(client.saveFile("dirty", "one")).rejects.toThrow(
      "changed externally",
    );
    expect(api.saveExplorerFile).toHaveBeenCalledTimes(1);
  });
});
