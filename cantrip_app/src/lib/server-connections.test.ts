import { beforeEach, describe, expect, it, vi } from "vitest";

import { serverConnectionStorageKey } from "./server-connection-storage";

import {
  getActiveServerConnection,
  getServerConnections,
  initializeServerConnections,
  normalizeServerUrl,
  removeServerConnection,
  saveServerConnection,
  selectServerConnection,
  testServerConnection,
} from "./server-connections";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

beforeEach(() => {
  const localStorage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
  vi.restoreAllMocks();
});

describe("server connections", () => {
  it("normalizes safe server origins", () => {
    expect(normalizeServerUrl(" https://cantrip.example/ ")).toBe(
      "https://cantrip.example",
    );
    expect(() => normalizeServerUrl("ws://cantrip.example")).toThrow(/http/);
    expect(() => normalizeServerUrl("https://cantrip.example/prefix")).toThrow(
      /without a path/,
    );
  });

  it("persists remote profiles and falls back to local after deletion", async () => {
    await initializeServerConnections();
    const remote = await saveServerConnection({
      name: "Desk server",
      url: "https://desk.example/",
    });
    await selectServerConnection(remote.id);
    expect(getActiveServerConnection()).toMatchObject({
      name: "Desk server",
      url: "https://desk.example",
    });

    await initializeServerConnections();
    expect(getServerConnections()).toHaveLength(2);
    expect(getActiveServerConnection().id).toBe(remote.id);

    await removeServerConnection(remote.id);
    expect(getActiveServerConnection().kind).toBe("local");
  });

  it("preserves profiles saved by another browser tab", async () => {
    await initializeServerConnections();
    localStorage.setItem(
      serverConnectionStorageKey,
      JSON.stringify({
        activeId: "first-remote",
        connections: [
          {
            id: "first-remote",
            kind: "remote",
            name: "First remote",
            url: "https://first.example",
          },
        ],
        updatedAt: Date.now() + 1_000,
        version: 1,
      }),
    );

    await saveServerConnection({
      name: "Second remote",
      url: "https://second.example",
    });

    expect(getServerConnections().map((connection) => connection.name)).toEqual(
      ["Local", "First remote", "Second remote"],
    );
  });

  it("does not retain an in-memory profile when browser storage is blocked", async () => {
    await initializeServerConnections();
    vi.spyOn(localStorage, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });

    await expect(
      saveServerConnection({
        name: "Unsaved remote",
        url: "https://unsaved.example",
      }),
    ).rejects.toThrow(/could not save/i);
    expect(getServerConnections()).toHaveLength(1);
  });

  it("distinguishes unreachable and incompatible servers", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("failed")));
    await expect(
      testServerConnection("https://offline.example"),
    ).rejects.toMatchObject({
      kind: "network",
    });

    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ service: "not-cantrip" }), {
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    await expect(
      testServerConnection("https://old.example"),
    ).rejects.toMatchObject({
      kind: "compatibility",
    });
  });

  it("reports whether a compatible server still requires sign-in", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            protocolVersion: 1,
            server: {
              id: "hosted-one",
              version: {
                major: 1,
                minor: 1,
                patch: 1375,
                version: "1.1.1375",
              },
              deploymentMode: "hosted",
              bootstrapMode: "standalone",
            },
            auth: {
              mode: "accounts",
              state: "authentication-required",
              currentUser: null,
              registration: { enabled: true, bootstrapRequired: false },
            },
            routing: {
              workerConnection: "server-only",
              directWorkerConnections: false,
            },
            storage: { conversations: "server", files: "worker" },
            agent: { model: "gpt-5.6-sol", modelProvider: "chatgpt" },
            capabilities: {
              accounts: true,
              passwordProtection: false,
              linkCodes: false,
              multipleWorkers: false,
              workerSwitching: false,
              gitSync: false,
              worktrees: true,
              remoteSurfaces: {
                enabled: true,
                transports: ["websocket"],
                relayOnly: true,
              },
              code: {
                enabled: true,
                transport: "web-proxy",
                isolatedOrigin: true,
              },
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    );

    const bootstrap = await testServerConnection("https://cantrip.example");
    expect(bootstrap.auth).toMatchObject({
      mode: "accounts",
      state: "authentication-required",
    });
  });
});
