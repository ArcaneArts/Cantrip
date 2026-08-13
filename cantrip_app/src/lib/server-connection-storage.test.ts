import { describe, expect, it, vi } from "vitest";

import {
  readServerConnectionPayloads,
  type ServerConnectionStorageAccess,
  writeServerConnectionPayload,
} from "./server-connection-storage";

function storageAccess(
  overrides: Partial<ServerConnectionStorageAccess> = {},
): ServerConnectionStorageAccess {
  return {
    readBackup: async () => null,
    readPrimary: () => null,
    requestPersistence: async () => false,
    writeBackup: async () => undefined,
    writePrimary: () => undefined,
    ...overrides,
  };
}

describe("server connection storage", () => {
  it("restores the backup when primary browser storage is unavailable", async () => {
    await expect(
      readServerConnectionPayloads(
        storageAccess({
          readBackup: async () => "backup",
          readPrimary: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        }),
      ),
    ).resolves.toEqual(["backup"]);
  });

  it("writes redundant copies and requests durable browser storage", async () => {
    const writePrimary = vi.fn();
    const writeBackup = vi.fn(async () => undefined);
    const requestPersistence = vi.fn(async () => true);

    await writeServerConnectionPayload(
      "payload",
      storageAccess({ writePrimary, writeBackup, requestPersistence }),
    );

    expect(writePrimary).toHaveBeenCalledWith("payload");
    expect(writeBackup).toHaveBeenCalledWith("payload");
    expect(requestPersistence).toHaveBeenCalledOnce();
  });

  it("keeps saving when either redundant storage backend fails", async () => {
    await expect(
      writeServerConnectionPayload(
        "payload",
        storageAccess({
          writePrimary: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        }),
      ),
    ).resolves.toBeUndefined();

    await expect(
      writeServerConnectionPayload(
        "payload",
        storageAccess({
          writeBackup: async () => {
            throw new Error("unavailable");
          },
        }),
      ),
    ).resolves.toBeUndefined();
  });

  it("reports when no browser storage backend can save", async () => {
    await expect(
      writeServerConnectionPayload(
        "payload",
        storageAccess({
          writeBackup: async () => {
            throw new Error("unavailable");
          },
          writePrimary: () => {
            throw new DOMException("blocked", "SecurityError");
          },
        }),
      ),
    ).rejects.toThrow(/could not save/i);
  });
});
