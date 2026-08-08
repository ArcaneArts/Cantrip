import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  getActiveServerConnection,
  getServerConnections,
  initializeServerConnections,
  normalizeServerUrl,
  removeServerConnection,
  saveServerConnection,
  selectServerConnection,
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
    const remote = saveServerConnection({
      name: "Desk server",
      url: "https://desk.example/",
    });
    selectServerConnection(remote.id);
    expect(getActiveServerConnection()).toMatchObject({
      name: "Desk server",
      url: "https://desk.example",
    });

    await initializeServerConnections();
    expect(getServerConnections()).toHaveLength(2);
    expect(getActiveServerConnection().id).toBe(remote.id);

    removeServerConnection(remote.id);
    expect(getActiveServerConnection().kind).toBe("local");
  });
});
