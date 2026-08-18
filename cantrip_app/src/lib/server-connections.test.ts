import { beforeEach, describe, expect, it, vi } from "vitest";

import { serverConnectionStorageKey } from "./server-connection-storage";

const tauriApi = vi.hoisted(() => ({
  invoke: vi.fn(),
  isTauri: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => tauriApi);

import {
  getActiveServerConnection,
  getServerConnections,
  initializeServerConnections,
  normalizeServerUrl,
  rememberActiveServerAccount,
  removeServerConnection,
  saveServerConnection,
  selectServerConnection,
  suggestedServerUrlForName,
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
  vi.restoreAllMocks();
  tauriApi.invoke.mockReset();
  tauriApi.isTauri.mockReset();
  tauriApi.isTauri.mockReturnValue(false);
  const localStorage = new MemoryStorage();
  vi.stubGlobal("window", { localStorage });
  vi.stubGlobal("localStorage", localStorage);
});

describe("server connections", () => {
  it("normalizes safe server origins", () => {
    expect(normalizeServerUrl(" https://cantrip.example/ ")).toBe(
      "https://cantrip.example",
    );
    expect(() => normalizeServerUrl("ws://cantrip.example")).toThrow(/http/);
    expect(normalizeServerUrl("cantrip.example")).toBe(
      "https://cantrip.example",
    );
    expect(normalizeServerUrl("localhost:4310")).toBe("https://localhost:4310");
    expect(normalizeServerUrl("http://localhost:4310")).toBe(
      "http://localhost:4310",
    );
    expect(() => normalizeServerUrl("https://cantrip.example/prefix")).toThrow(
      /without a path/,
    );
  });

  it("suggests the hosted server only for the exact Winterhold name", () => {
    expect(suggestedServerUrlForName("Winterhold")).toBe(
      "https://winterhold.cantrip.art/",
    );
    expect(suggestedServerUrlForName("winterhold")).toBeNull();
    expect(suggestedServerUrlForName("Winterhold ")).toBeNull();
  });

  it("requires a remote profile outside the desktop app", async () => {
    await initializeServerConnections();
    expect(getServerConnections()).toEqual([]);
    expect(getActiveServerConnection()).toBeNull();

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
    expect(getServerConnections()).toHaveLength(1);
    expect(getActiveServerConnection()?.id).toBe(remote.id);

    await removeServerConnection(remote.id);
    expect(getServerConnections()).toEqual([]);
    expect(getActiveServerConnection()).toBeNull();
  });

  it("keeps the embedded local profile in the Tauri desktop app", async () => {
    tauriApi.isTauri.mockReturnValue(true);
    tauriApi.invoke.mockResolvedValue("http://127.0.0.1:4310");

    await initializeServerConnections();

    expect(tauriApi.invoke).toHaveBeenCalledWith("local_server_url");
    expect(getServerConnections()).toEqual([
      {
        accountId: null,
        id: "local",
        kind: "local",
        name: "Local",
        url: "http://127.0.0.1:4310",
      },
    ]);
    expect(getActiveServerConnection()?.kind).toBe("local");
  });

  it("pins a remote server to one account unless sign-in explicitly replaces it", async () => {
    await initializeServerConnections();
    const remote = await saveServerConnection({
      name: "Hosted",
      url: "https://hosted.example",
    });
    await selectServerConnection(remote.id);

    await expect(rememberActiveServerAccount("account-a")).resolves.toBe(true);
    expect(getActiveServerConnection()?.accountId).toBe("account-a");
    await expect(rememberActiveServerAccount("account-b")).resolves.toBe(false);
    expect(getActiveServerConnection()?.accountId).toBe("account-a");
    await expect(rememberActiveServerAccount("account-b", true)).resolves.toBe(
      true,
    );
    expect(getActiveServerConnection()?.accountId).toBe("account-b");

    await initializeServerConnections();
    expect(getActiveServerConnection()?.accountId).toBe("account-b");
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
      ["First remote", "Second remote"],
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
    expect(getServerConnections()).toHaveLength(0);
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
