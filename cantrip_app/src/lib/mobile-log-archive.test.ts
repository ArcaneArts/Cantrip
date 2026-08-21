import { beforeAll, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  const key = (directory: string, path: string) => `${directory}:${path}`;
  let stateListener: ((state: { isActive: boolean }) => void) | null = null;
  return {
    files,
    key,
    app: {
      addListener: vi.fn(
        async (_event: string, listener: typeof stateListener) => {
          stateListener = listener;
          return { remove: vi.fn() };
        },
      ),
    },
    capacitor: { isNativePlatform: vi.fn(() => true) },
    filesystem: {
      appendFile: vi.fn(
        async ({
          data,
          directory,
          path,
        }: {
          data: string;
          directory: string;
          path: string;
        }) => {
          const previous = files.get(key(directory, path)) ?? new Uint8Array();
          const binary = atob(data);
          const added = Uint8Array.from(binary, (character) =>
            character.charCodeAt(0),
          );
          const next = new Uint8Array(previous.byteLength + added.byteLength);
          next.set(previous);
          next.set(added, previous.byteLength);
          files.set(key(directory, path), next);
        },
      ),
      deleteFile: vi.fn(
        async ({ directory, path }: { directory: string; path: string }) => {
          files.delete(key(directory, path));
        },
      ),
      getUri: vi.fn(
        async ({ directory, path }: { directory: string; path: string }) => ({
          uri: `file://${key(directory, path)}`,
        }),
      ),
      mkdir: vi.fn(async () => undefined),
      readFileInChunks: vi.fn(
        async (
          { directory, path }: { directory: string; path: string },
          callback: (chunk: { data: string } | null, error?: unknown) => void,
        ) => {
          const bytes = files.get(key(directory, path)) ?? new Uint8Array();
          let binary = "";
          for (const byte of bytes) binary += String.fromCharCode(byte);
          callback({ data: btoa(binary) });
          callback(null);
          return "read-id";
        },
      ),
      readdir: vi.fn(
        async ({ directory, path }: { directory: string; path: string }) => {
          const prefix = `${directory}:${path}/`;
          return {
            files: [...files]
              .filter(([name]) => name.startsWith(prefix))
              .map(([name, bytes]) => ({
                ctime: Date.now(),
                mtime: Date.now(),
                name: name.slice(prefix.length),
                size: bytes.byteLength,
                type: "file" as const,
                uri: `file://${name}`,
              })),
          };
        },
      ),
      rename: vi.fn(
        async ({
          directory,
          from,
          to,
        }: {
          directory: string;
          from: string;
          to: string;
        }) => {
          files.set(key(directory, to), files.get(key(directory, from))!);
          files.delete(key(directory, from));
        },
      ),
      writeFile: vi.fn(
        async ({
          data,
          directory,
          path,
        }: {
          data: string;
          directory: string;
          path: string;
        }) => {
          const binary = atob(data);
          files.set(
            key(directory, path),
            Uint8Array.from(binary, (character) => character.charCodeAt(0)),
          );
          return { uri: `file://${key(directory, path)}` };
        },
      ),
    },
    getStateListener: () => stateListener,
    share: { share: vi.fn(async () => ({ activityType: "test" })) },
  };
});

vi.mock("@capacitor/app", () => ({ App: native.app }));
vi.mock("@capacitor/core", () => ({ Capacitor: native.capacitor }));
vi.mock("@capacitor/filesystem", () => ({
  Directory: { Cache: "CACHE", LibraryNoCloud: "LIBRARY_NO_CLOUD" },
  Filesystem: native.filesystem,
}));
vi.mock("@capacitor/share", () => ({ Share: native.share }));

import {
  exportMobileClientLogs,
  initializeMobileClientLogArchive,
  persistMobileClientLog,
} from "./mobile-log-archive";

describe("mobile client log archive", () => {
  beforeAll(() => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {},
    });
  });

  it("persists records, maintains on resume, and exports only the client archive", async () => {
    const archive = await initializeMobileClientLogArchive();
    expect(archive).not.toBeNull();
    persistMobileClientLog({
      cursor: 1,
      level: "info",
      message: "mobile.ready",
      system: "client",
      timestamp: "2026-08-21T00:00:00.000Z",
    });
    await Promise.resolve();
    await archive!.flush();
    const archiveNames = [...native.files.keys()].filter((name) =>
      name.startsWith("LIBRARY_NO_CLOUD:logs/client/client-"),
    );
    expect(archiveNames).toHaveLength(1);

    const readsBeforeResume = native.filesystem.readdir.mock.calls.length;
    native.getStateListener()?.({ isActive: true });
    await Promise.resolve();
    await archive!.flush();
    expect(native.filesystem.readdir.mock.calls.length).toBeGreaterThan(
      readsBeforeResume,
    );

    await exportMobileClientLogs();
    expect(native.share.share).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [expect.stringContaining("cantrip-client-logs-")],
      }),
    );
    const exported = [...native.files.keys()].filter((name) =>
      name.endsWith(".zip"),
    );
    expect(exported).toHaveLength(1);
    expect(native.files.get(exported[0]!)!.byteLength).toBeGreaterThan(0);
  });
});
