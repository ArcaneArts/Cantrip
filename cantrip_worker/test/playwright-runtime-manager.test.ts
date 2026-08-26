import { EventEmitter } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import os from "node:os";
import path from "node:path";

import { managedWebRuntimeStatusSchema } from "@cantrip/protocol";
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
});
