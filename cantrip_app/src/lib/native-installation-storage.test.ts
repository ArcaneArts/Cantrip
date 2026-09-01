import { describe, expect, it, vi } from "vitest";

import type { DurableClientEncryptionStorage } from "./durable-account-encryption";
import {
  openNativeInstallationStorage,
  type NativeInstallationStorageFactories,
} from "./native-installation-storage";

function fixtureStorage(label: string) {
  return { label } as unknown as DurableClientEncryptionStorage;
}

function factories(): NativeInstallationStorageFactories & {
  capacitor: ReturnType<typeof vi.fn>;
  tauri: ReturnType<typeof vi.fn>;
} {
  return {
    capacitor: vi.fn(() => Promise.resolve(fixtureStorage("capacitor"))),
    tauri: vi.fn(() => Promise.resolve(fixtureStorage("tauri"))),
  };
}

describe("native installation storage runtime selection", () => {
  it("selects Tauri storage only for the Tauri runtime", async () => {
    const openers = factories();
    await expect(
      openNativeInstallationStorage("tauri", openers),
    ).resolves.toMatchObject({ label: "tauri" });
    expect(openers.tauri).toHaveBeenCalledOnce();
    expect(openers.capacitor).not.toHaveBeenCalled();
  });

  it.each(["capacitor-ios", "capacitor-android"] as const)(
    "selects Capacitor storage for %s",
    async (platform) => {
      const openers = factories();
      await expect(
        openNativeInstallationStorage(platform, openers),
      ).resolves.toMatchObject({ label: "capacitor" });
      expect(openers.capacitor).toHaveBeenCalledOnce();
      expect(openers.tauri).not.toHaveBeenCalled();
    },
  );

  it.each(["browser", "unsupported-native"] as const)(
    "fails closed instead of selecting a native provider for %s",
    async (platform) => {
      const openers = factories();
      await expect(
        openNativeInstallationStorage(platform, openers),
      ).rejects.toMatchObject({ code: "key-store-unavailable" });
      expect(openers.capacitor).not.toHaveBeenCalled();
      expect(openers.tauri).not.toHaveBeenCalled();
    },
  );
});
