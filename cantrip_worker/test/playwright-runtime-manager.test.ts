import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import os from "node:os";
import path from "node:path";

import { managedWebRuntimeStatusSchema } from "@cantrip/protocol";
import type { CantripMcpBinding } from "@cantrip/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BrowserNetworkProxy } from "../src/managed-runtimes/browser-proxy.js";
import { PlaywrightRuntimeManager } from "../src/managed-runtimes/playwright.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "cantrip-playwright-manager-"),
  );
  temporaryDirectories.push(directory);
  const executable = path.join(
    directory,
    "browsers",
    "chromium_headless_shell-1234",
    process.platform === "win32"
      ? "chrome-headless-shell.exe"
      : "headless_shell",
  );
  await mkdir(path.dirname(executable), { recursive: true });
  await writeFile(executable, "fixture");
  return directory;
}

function readyStatus() {
  return managedWebRuntimeStatusSchema.parse({
    component: "playwright",
    supported: true,
    state: "ready",
    installedVersion: "2026.08.22.1",
    latestVersion: "2026.08.22.1",
    previousVersion: null,
    progress: null,
    failure: null,
    lastCheckedAt: new Date(0).toISOString(),
  });
}

describe("PlaywrightRuntimeManager", () => {
  it("lazily renders in an isolated context and validates every navigation", async () => {
    const runtime = await fixture();
    const state = await fixture();
    const routeContinue = vi.fn(async () => undefined);
    const contextClose = vi.fn(async () => undefined);
    let routeHandler: ((route: unknown) => Promise<void>) | null = null;
    const processEvents = Object.assign(new EventEmitter(), {
      spawnargs: ["chromium", "--headless"],
    });
    const browserClose = vi.fn(async () => undefined);
    const serverClose = vi.fn(async () => undefined);
    const manager = new PlaywrightRuntimeManager({
      dataDirectory: state,
      installer: {
        prepare: async () => readyStatus(),
        rollback: async () => readyStatus(),
        runtimeDirectory: () => runtime,
        status: () => readyStatus(),
      },
      proxyFactory: () =>
        ({
          start: async () => "http://127.0.0.1:41000",
          close: async () => undefined,
        }) as unknown as BrowserNetworkProxy,
      loadPlaywright: async () =>
        ({
          chromium: {
            launchServer: async () => ({
              close: serverClose,
              process: () => processEvents,
              wsEndpoint: () => "ws://127.0.0.1:41001/fixture",
            }),
            connect: async () => ({
              close: browserClose,
              newContext: async () => ({
                close: contextClose,
                route: async (
                  _pattern: string,
                  handler: (route: unknown) => Promise<void>,
                ) => {
                  routeHandler = handler;
                },
                newPage: async () => ({
                  goto: async (url: string) => {
                    await routeHandler!({
                      abort: async () => undefined,
                      continue: routeContinue,
                      request: () => ({
                        isNavigationRequest: () => true,
                        method: () => "GET",
                        resourceType: () => "document",
                        url: () => url,
                      }),
                    });
                  },
                  content: async () =>
                    "<html><body><main>Rendered research body</main></body></html>",
                  locator: () => ({ ariaSnapshot: async () => "" }),
                  title: async () => "Rendered title",
                  url: () => "https://example.com/final",
                }),
              }),
            }),
          },
        }) as never,
    });
    const navigation = vi.fn(async () => undefined);
    const rendered = await manager.render(
      "https://example.com/start",
      navigation,
    );
    expect(rendered).toMatchObject({
      title: "Rendered title",
      url: "https://example.com/final",
    });
    expect(navigation).toHaveBeenCalledOnce();
    expect(routeContinue).toHaveBeenCalledOnce();
    expect(contextClose).toHaveBeenCalledOnce();
    await manager.close();
    expect(browserClose).toHaveBeenCalledOnce();
    expect(serverClose).toHaveBeenCalledOnce();
  });

  it("fences interactive element references by owner and generation", async () => {
    const runtime = await fixture();
    const state = await fixture();
    const click = vi.fn(async () => undefined);
    const fill = vi.fn(async () => undefined);
    const element = {
      ariaSnapshot: async () => '- button "Search"',
      click,
      count: async () => 1,
      fill,
      nth: () => element,
      press: vi.fn(async () => undefined),
    };
    const body = { ...element, ariaSnapshot: async () => "- document Web" };
    let currentUrl = "about:blank";
    let routeHandler: ((route: unknown) => Promise<void>) | null = null;
    const contextClose = vi.fn(async () => undefined);
    const page = {
      content: async () => "",
      goto: async (url: string) => {
        await routeHandler!({
          abort: async () => undefined,
          continue: async () => undefined,
          request: () => ({
            isNavigationRequest: () => true,
            method: () => "GET",
            resourceType: () => "document",
            url: () => url,
          }),
        });
        currentUrl = url;
      },
      locator: (selector: string) => (selector === "body" ? body : element),
      title: async () => "Web",
      url: () => currentUrl,
      waitForLoadState: async () => undefined,
    };
    const processEvents = Object.assign(new EventEmitter(), {
      spawnargs: ["chromium", "--headless"],
    });
    const manager = new PlaywrightRuntimeManager({
      dataDirectory: state,
      installer: {
        prepare: async () => readyStatus(),
        rollback: async () => readyStatus(),
        runtimeDirectory: () => runtime,
        status: () => readyStatus(),
      },
      proxyFactory: () =>
        ({
          start: async () => "http://127.0.0.1:41000",
          close: async () => undefined,
        }) as unknown as BrowserNetworkProxy,
      loadPlaywright: async () =>
        ({
          chromium: {
            launchServer: async () => ({
              close: async () => undefined,
              process: () => processEvents,
              wsEndpoint: () => "ws://127.0.0.1:41001/fixture",
            }),
            connect: async () => ({
              close: async () => undefined,
              newContext: async () => ({
                close: contextClose,
                route: async (
                  _pattern: string,
                  handler: (route: unknown) => Promise<void>,
                ) => {
                  routeHandler = handler;
                },
                newPage: async () => page,
              }),
            }),
          },
        }) as never,
    });
    const binding = {
      bindingId: "00000000-0000-4000-8000-000000000001",
      ownerId: "owner-one",
      contextKind: "project",
      projectId: "project-one",
      chatId: "chat-one",
      executionLaneId: "lane-one",
      workerId: "worker-one",
      worktreeId: "worktree-one",
      rootKind: "git-worktree",
      scratchRootId: null,
      permissionProfileId: ":workspace-write",
      allowedOperations: [],
      issuedAt: "2026-08-21T12:00:00.000Z",
      expiresAt: "2026-08-21T18:00:00.000Z",
    } as CantripMcpBinding;
    const opened = await manager.openSession(binding, "https://example.com/");
    const first = await manager.snapshotSession(
      binding,
      opened.sessionId,
      5_000,
    );
    const repeated = await manager.snapshotSession(
      binding,
      opened.sessionId,
      5_000,
    );
    expect(repeated.elements).toEqual(first.elements);
    await expect(
      manager.snapshotSession(
        { ...binding, chatId: "other-chat" },
        opened.sessionId,
        5_000,
      ),
    ).rejects.toThrow(/unavailable/u);
    await manager.clickSession(
      binding,
      opened.sessionId,
      first.elements[0]!.ref,
    );
    expect(click).toHaveBeenCalledOnce();
    await expect(
      manager.clickSession(binding, opened.sessionId, first.elements[0]!.ref),
    ).rejects.toThrow(/stale/u);
    await manager.closeSession(binding, opened.sessionId);
    expect(contextClose).toHaveBeenCalledOnce();
    const profileMarker = path.join(
      state,
      "managed-runtimes",
      "playwright",
      "state",
      "profiles",
      "saved-cookie",
    );
    await writeFile(profileMarker, "private");
    await manager.action("clear-profiles");
    await expect(readFile(profileMarker)).rejects.toThrow();
    await manager.close();
  });
});

describe("BrowserNetworkProxy", () => {
  it("rejects CONNECT destinations whose DNS contains a private address", async () => {
    const proxy = new BrowserNetworkProxy({
      lookup: async () => [{ address: "127.0.0.1", family: 4 }] as never,
    });
    const origin = new URL(await proxy.start());
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(origin.port), origin.hostname);
      let received = "";
      socket.once("error", reject);
      socket.on("data", (chunk) => (received += chunk));
      socket.once("close", () => resolve(received));
      socket.once("connect", () =>
        socket.end(
          "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n",
        ),
      );
    });
    expect(response).toContain("502 Bad Gateway");
    await proxy.close();
  });

  it("closes a CONNECT client when the upstream socket resets", async () => {
    const upstream = createServer((socket) => {
      socket.on("error", () => undefined);
      setTimeout(() => socket.destroy(new Error("fixture reset")), 20);
    });
    await new Promise<void>((resolve, reject) => {
      upstream.once("error", reject);
      upstream.listen(0, "127.0.0.1", resolve);
    });
    const address = upstream.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture upstream did not bind a TCP port.");
    }
    const proxy = new BrowserNetworkProxy({
      connectSocket: () => connect(address.port, "127.0.0.1"),
      lookup: async () => [{ address: "93.184.216.34", family: 4 }] as never,
    });
    const origin = new URL(await proxy.start());
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(origin.port), origin.hostname);
      let received = "";
      const timeout = setTimeout(
        () => reject(new Error("Proxy client did not close after reset.")),
        1_000,
      );
      socket.once("error", reject);
      socket.on("data", (chunk) => (received += chunk));
      socket.once("close", () => {
        clearTimeout(timeout);
        resolve(received);
      });
      socket.once("connect", () =>
        socket.write(
          "CONNECT example.test:443 HTTP/1.1\r\nHost: example.test:443\r\n\r\n",
        ),
      );
    });
    expect(response).toContain("200 Connection Established");
    await proxy.close();
    await new Promise<void>((resolve, reject) => {
      upstream.close((error) => (error ? reject(error) : resolve()));
    });
  });
});
