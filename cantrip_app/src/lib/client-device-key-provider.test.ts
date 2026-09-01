import {
  clearSensitiveBytes,
  wrapAccountMasterKeyForClient,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import {
  MemoryClientDeviceKeyBackend,
  MemoryClientDeviceKeyProvider,
  type ClientDeviceKeyDescriptor,
} from "./client-device-key-provider";
import { installationKeyAlias } from "./installation-catalog";

const installationId = "29aedfc0-9b5b-49df-8448-b82b94495ea5";
const keyAlias = installationKeyAlias(installationId);

describe("client device key provider contract", () => {
  it("creates one stable key for an installation alias", async () => {
    const backend = new MemoryClientDeviceKeyBackend();
    const provider = new MemoryClientDeviceKeyProvider(backend);
    const secondProvider = new MemoryClientDeviceKeyProvider(backend);
    const [first, concurrent] = await Promise.all([
      provider.create({
        createdAt: "2026-08-31T18:00:00.000Z",
        installationId,
        keyAlias,
      }),
      secondProvider.create({ installationId, keyAlias }),
    ]);
    const second = await provider.create({ installationId, keyAlias });

    expect(concurrent).toEqual(first);
    expect(second).toEqual(first);
    await expect(provider.inspect(keyAlias)).resolves.toEqual(first);
  });

  it("owns the private-key operation and returns only the unwrapped master key", async () => {
    const provider = new MemoryClientDeviceKeyProvider();
    const descriptor: ClientDeviceKeyDescriptor = await provider.create({
      installationId,
      keyAlias,
    });
    const expected = new Uint8Array(32).fill(47);
    const wrapper = await wrapAccountMasterKeyForClient({
      accountMasterKey: expected,
      clientId: "binding-principal-a",
      clientPublicKey: descriptor.publicKey,
      masterKeyRevision: 1,
      ownerId: "owner-a",
    });

    const opened = await provider.unwrapAccountMasterKey({
      keyAlias,
      ownerId: "owner-a",
      wrapper,
    });
    expect(opened).toEqual(expected);

    clearSensitiveBytes(opened);
    clearSensitiveBytes(expected);
  });

  it("does not synthesize a replacement when the requested key is missing", async () => {
    const provider = new MemoryClientDeviceKeyProvider();

    await expect(
      provider.unwrapAccountMasterKey({
        keyAlias,
        ownerId: "owner-a",
        wrapper: {} as never,
      }),
    ).rejects.toMatchObject({ code: "key-missing" });
    await expect(provider.inspect(keyAlias)).resolves.toBeNull();
  });
});
