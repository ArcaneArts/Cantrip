import {
  decryptSurfacePrivateState,
  deriveComponentKey,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import {
  decodeSurfacePrivateStateForClient,
  encodeSurfacePrivateStateForClient,
} from "./surface-private-state-encryption";

const identity = {
  ownerId: "owner-surface-client",
  serverId: "https://cantrip.test",
};
const context = {
  serverId: identity.serverId,
  resource: "browser-operation" as const,
  resourceId: "browser-1",
  operationId: "navigate-1",
  recordKind: "browser-state" as const,
};
const content = {
  version: 1 as const,
  classification: { recordKind: "browser-state" as const },
  revision: 1,
  url: "https://private.example/path",
};

function unlocked(accountMasterKey = generateAccountMasterKey(), revision = 3) {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey,
    identity,
    masterKeyRevision: revision,
  });
  return service;
}

describe("client surface private-state adapter", () => {
  it("agrees with the shared codec through the scoped component key", async () => {
    const accountMasterKey = generateAccountMasterKey();
    const service = unlocked(accountMasterKey);
    const opaque = await encodeSurfacePrivateStateForClient({
      identity,
      context,
      content,
      service,
    });
    const componentKey = deriveComponentKey({
      accountMasterKey,
      ownerId: identity.ownerId,
      component: "surface-private-state",
      keyRevision: 3,
    });
    await expect(
      decryptSurfacePrivateState({
        ownerId: identity.ownerId,
        context,
        keyRevision: 3,
        componentKey,
        opaque,
      }),
    ).resolves.toEqual(content);
    await expect(
      decodeSurfacePrivateStateForClient({
        identity,
        context,
        opaque,
        service,
      }),
    ).resolves.toEqual(content);
  });

  it("fails closed for locked, stale, wrong-server, corrupt, and unsupported state", async () => {
    await expect(
      encodeSurfacePrivateStateForClient({
        identity,
        context,
        content,
        service: new ClientEncryptionService(),
      }),
    ).rejects.toMatchObject({ state: "locked" });

    const service = unlocked(undefined, 2);
    const opaque = await encodeSurfacePrivateStateForClient({
      identity,
      context,
      content,
      service,
    });
    await expect(
      decodeSurfacePrivateStateForClient({
        identity,
        context,
        opaque,
        service: unlocked(undefined, 3),
      }),
    ).rejects.toMatchObject({ state: "stale" });
    await expect(
      decodeSurfacePrivateStateForClient({
        identity,
        context: { ...context, serverId: "https://other.test" },
        opaque,
        service,
      }),
    ).rejects.toMatchObject({ state: "wrong-recipient" });

    const ciphertext = opaque.protectedState.envelope.ciphertext;
    await expect(
      decodeSurfacePrivateStateForClient({
        identity,
        context,
        opaque: {
          ...opaque,
          protectedState: {
            ...opaque.protectedState,
            envelope: {
              ...opaque.protectedState.envelope,
              ciphertext: `${ciphertext.startsWith("A") ? "B" : "A"}${ciphertext.slice(1)}`,
            },
          },
        },
        service,
      }),
    ).rejects.toMatchObject({ state: "corrupt" });
    await expect(
      decodeSurfacePrivateStateForClient({
        identity,
        context,
        opaque: {
          ...opaque,
          protectedState: { ...opaque.protectedState, formatVersion: 2 },
        },
        service,
      }),
    ).rejects.toMatchObject({ state: "unsupported" });
  });
});
