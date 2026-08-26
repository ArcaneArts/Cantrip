import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import type { ManagedWebRuntimeStatus } from "@cantrip/protocol";

import {
  renderSearxngSettings,
  SearxngRuntimeManager,
  validateSearxngInventory,
} from "../src/managed-runtimes/searxng.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

function status(
  state: ManagedWebRuntimeStatus["state"] = "ready",
): ManagedWebRuntimeStatus {
  return {
    component: "searxng",
    supported: true,
    state,
    installedVersion: state === "ready" ? "2026.08.22.1" : null,
    previousVersion: null,
    latestVersion: "2026.08.22.1",
    lastCheckedAt: "2026-08-26T12:00:00.000Z",
    progress: null,
    failure: null,
  };
}

async function fixtureRuntime(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "cantrip-searxng-test-"));
  temporaryDirectories.push(root);
  const files = [
    process.platform === "win32"
      ? "python/python.exe"
      : "python/bin/python3.13",
    "app/searxng/searx/webapp.py",
    "app/searxng/searx/version_frozen.py",
    "config-template/settings.yml",
    "config-template/smoke-settings.yml",
    "launcher/serve.py",
    "licenses/manifest.json",
    "source/manifest.json",
    "sbom.cdx.json",
  ];
  for (const relative of files) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      relative.startsWith("config-template/")
        ? 'port: __CANTRIP_PORT__\nsecret: "__CANTRIP_SECRET__"\n'
        : "fixture\n",
    );
  }
  await writeFile(
    path.join(root, "build-info.json"),
    JSON.stringify({
      schemaVersion: 1,
      component: "searxng",
      version: "2026.08.22.1",
    }),
  );
  return root;
}

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & {
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
    stderr: PassThrough;
    stdout: PassThrough;
  };
  child.exitCode = null;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    child.exitCode = 0;
    queueMicrotask(() => child.emit("exit", 0, null));
    return true;
  });
  return child;
}

describe("SearXNG managed runtime", () => {
  it("renders exactly one private loopback settings template", () => {
    const rendered = renderSearxngSettings(
      'port: __CANTRIP_PORT__\nsecret: "__CANTRIP_SECRET__"\n',
      43_210,
      "a".repeat(64),
    );
    expect(rendered).toContain("port: 43210");
    expect(rendered).toContain(`secret: "${"a".repeat(64)}"`);
    expect(() => renderSearxngSettings("port: 1", 1, "a".repeat(64))).toThrow(
      /placeholders/u,
    );
  });

  it("accepts a complete immutable inventory and rejects mismatched metadata", async () => {
    const runtime = await fixtureRuntime();
    await expect(
      validateSearxngInventory(runtime, "2026.08.22.1"),
    ).resolves.toBeUndefined();
    await expect(
      validateSearxngInventory(runtime, "different"),
    ).rejects.toThrow(/does not match/u);
  });

  it("coalesces preparation, serves loopback requests, advertises readiness, and shuts down", async () => {
    const runtime = await fixtureRuntime();
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-searxng-state-"),
    );
    temporaryDirectories.push(dataDirectory);
    const prepare = vi.fn(async () => status());
    const child = fakeChild();
    const spawn = vi.fn(() => child as never);
    const fetchImplementation = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      return Response.json(
        url.endsWith("/healthz")
          ? { status: "ok" }
          : { query: "fixture", results: [] },
      );
    }) as unknown as typeof fetch;
    const manager = new SearxngRuntimeManager({
      dataDirectory,
      fetch: fetchImplementation,
      installer: {
        prepare,
        rollback: vi.fn(async () => status()),
        runtimeDirectory: () => runtime,
        status: () => status(),
      },
      spawn: spawn as never,
      updateIntervalMs: 60_000,
    });

    await Promise.all([manager.prepare(), manager.prepare()]);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect((await manager.endpoint()).origin).toMatch(
      /^http:\/\/127\.0\.0\.1:\d+$/u,
    );
    expect(manager.capabilities().search.state).toBe("ready");
    await manager.request("/search", new URLSearchParams({ q: "fixture" }));
    expect(String(fetchImplementation.mock.calls.at(-1)?.[0])).toContain(
      "/search?q=fixture",
    );
    await manager.close();
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("keeps worker capabilities available when installation is unavailable", async () => {
    const dataDirectory = await mkdtemp(
      path.join(os.tmpdir(), "cantrip-searxng-failed-"),
    );
    temporaryDirectories.push(dataDirectory);
    const failed = status("failed");
    failed.supported = false;
    failed.failure = {
      category: "download",
      message: "manifest unavailable",
      retryable: true,
      failedAt: "2026-08-26T12:00:00.000Z",
    };
    const manager = new SearxngRuntimeManager({
      dataDirectory,
      installer: {
        prepare: async () => failed,
        rollback: async () => failed,
        runtimeDirectory: () => null,
        status: () => failed,
      },
    });
    await manager.prepare();
    expect(manager.capabilities().search.state).toBe("failed");
    await expect(manager.endpoint()).rejects.toThrow(/runtime is failed/u);
    await manager.close();
  });
});
