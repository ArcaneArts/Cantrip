import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  cachedRemoteDesktopIcon,
  cacheRemoteDesktopIcon,
  resetRemoteDesktopIconMemoryCacheForTests,
} from "./remote-desktop-icon-cache";

class MemoryStorage implements Storage {
  readonly #values = new Map<string, string>();

  get length(): number {
    return this.#values.size;
  }

  clear(): void {
    this.#values.clear();
  }

  getItem(key: string): string | null {
    return this.#values.get(key) ?? null;
  }

  key(index: number): string | null {
    return [...this.#values.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.#values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.#values.set(key, value);
  }
}

describe("remote desktop icon cache", () => {
  beforeEach(() => {
    const localStorage = new MemoryStorage();
    vi.stubGlobal("window", { localStorage });
    vi.stubGlobal("localStorage", localStorage);
    resetRemoteDesktopIconMemoryCacheForTests();
  });

  it("persists icon data by worker and icon key", () => {
    expect(cachedRemoteDesktopIcon("worker-1", "code")).toBeUndefined();
    expect(cacheRemoteDesktopIcon("worker-1", "code", "aWNvbg==")).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    expect(cachedRemoteDesktopIcon("worker-1", "code")).toBe(
      "data:image/png;base64,aWNvbg==",
    );
    expect(cachedRemoteDesktopIcon("worker-2", "code")).toBeUndefined();

    resetRemoteDesktopIconMemoryCacheForTests();
    expect(cachedRemoteDesktopIcon("worker-1", "code")).toBe(
      "data:image/png;base64,aWNvbg==",
    );
  });

  it("remembers unavailable icons", () => {
    cacheRemoteDesktopIcon("worker-1", "helper", null);
    expect(cachedRemoteDesktopIcon("worker-1", "helper")).toBeNull();
  });
});
