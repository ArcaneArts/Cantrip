import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import {
  decodePrivateDisplayLabelForClient,
  encodePrivateDisplayLabelForClient,
} from "./private-label-encryption";

const identity = {
  ownerId: "owner-private-label-client",
  serverId: "server-private-label-client",
};

function service(revision = 3): ClientEncryptionService {
  const result = new ClientEncryptionService();
  result.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity,
    masterKeyRevision: revision,
  });
  return result;
}

describe("client private display-label adapter", () => {
  it("round-trips through the unlocked account component key", async () => {
    const client = service();
    const opaque = await encodePrivateDisplayLabelForClient({
      identity,
      label: "Private project",
      recordKind: "project",
      rowId: "project-1",
      service: client,
    });
    expect(opaque).not.toHaveProperty("label");
    await expect(
      decodePrivateDisplayLabelForClient({
        identity,
        opaque,
        recordKind: "project",
        rowId: "project-1",
        service: client,
      }),
    ).resolves.toBe("Private project");
  });

  it("reports locked, stale, corrupt, missing, and unsupported states", async () => {
    await expect(
      encodePrivateDisplayLabelForClient({
        identity,
        label: "Locked project",
        recordKind: "project",
        rowId: "project-1",
        service: new ClientEncryptionService(),
      }),
    ).rejects.toMatchObject({ state: "locked" });

    const client = service(2);
    const opaque = await encodePrivateDisplayLabelForClient({
      identity,
      label: "Private chat",
      recordKind: "chat",
      rowId: "chat-1",
      service: client,
    });
    const newerClient = service(3);
    await expect(
      decodePrivateDisplayLabelForClient({
        identity,
        opaque,
        recordKind: "chat",
        rowId: "chat-1",
        service: newerClient,
      }),
    ).rejects.toMatchObject({ state: "stale" });
    await expect(
      decodePrivateDisplayLabelForClient({
        identity,
        opaque: {
          ...opaque,
          protectedLabel: {
            ...opaque.protectedLabel,
            envelope: {
              ...opaque.protectedLabel.envelope,
              ciphertext: `${
                opaque.protectedLabel.envelope.ciphertext.startsWith("A")
                  ? "B"
                  : "A"
              }${opaque.protectedLabel.envelope.ciphertext.slice(1)}`,
            },
          },
        },
        recordKind: "chat",
        rowId: "chat-1",
        service: client,
      }),
    ).rejects.toMatchObject({ state: "corrupt" });
    await expect(
      decodePrivateDisplayLabelForClient({
        identity,
        opaque: null,
        recordKind: "chat",
        rowId: "chat-1",
        service: client,
      }),
    ).rejects.toMatchObject({ state: "missing" });
    await expect(
      decodePrivateDisplayLabelForClient({
        identity,
        opaque: {
          ...opaque,
          protectedLabel: { ...opaque.protectedLabel, formatVersion: 2 },
        },
        recordKind: "chat",
        rowId: "chat-1",
        service: client,
      }),
    ).rejects.toMatchObject({ state: "unsupported" });
  });

  it("preserves a revoked client state", async () => {
    const revoked = {
      getSnapshot: () => ({
        clientId: "client-1",
        identity,
        masterKeyRevision: null,
        status: "revoked" as const,
      }),
    } as unknown as ClientEncryptionService;
    await expect(
      encodePrivateDisplayLabelForClient({
        identity,
        label: "Revoked project",
        recordKind: "project",
        rowId: "project-1",
        service: revoked,
      }),
    ).rejects.toMatchObject({ state: "revoked" });
  });
});
