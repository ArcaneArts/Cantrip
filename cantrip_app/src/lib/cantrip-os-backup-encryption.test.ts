import { afterEach, expect, it } from "vitest";
import {
  clearSensitiveBytes,
  encryptCantripOsBackupMessage,
  generateAccountMasterKey,
} from "@cantrip/crypto";
import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import {
  protectCantripOsBackupRequest,
  openCantripOsBackupRequest,
  openCantripOsBackupResult,
} from "./cantrip-os-backup-encryption";

const operationId = "11111111-1111-4111-8111-111111111111";
const workspaceId = "22222222-2222-4222-8222-222222222222";
const identity = { ownerId: "owner", serverId: "server" };
const services: ClientEncryptionService[] = [];
afterEach(() => {
  for (const service of services.splice(0)) service.lock();
});
function fixture() {
  const service = new ClientEncryptionService();
  services.push(service);
  const key = generateAccountMasterKey();
  service.setAccountMasterKey({
    accountMasterKey: key,
    identity,
    masterKeyRevision: 1,
  });
  const session = () =>
    ({
      serverId: identity.serverId,
      user: { id: identity.ownerId },
    }) as ClientSessionContext;
  return { service, key, options: { service, session } };
}

it("authenticates old requests and responses after a component revision change, without storing plaintext labels", async () => {
  const { service, key, options } = fixture();
  const value = {
    action: "capture" as const,
    workspaceId,
    label: "Private 日本 profile",
    exclusions: ["repo/node_modules"],
  };
  const frame = await protectCantripOsBackupRequest(
    operationId,
    value,
    options,
  );
  expect(JSON.stringify(frame)).not.toContain(value.label);
  service.setAccountMasterKey({
    accountMasterKey: key,
    identity,
    masterKeyRevision: 2,
  });
  expect(await openCantripOsBackupRequest(operationId, frame, options)).toEqual(
    value,
  );
  const componentKey = service.componentKey({
    component: "repository-content",
    identity,
    keyRevision: 1,
  });
  try {
    const response = await encryptCantripOsBackupMessage({
      ...identity,
      operationId,
      keyRevision: 1,
      componentKey,
      direction: "response",
      plaintext: new TextEncoder().encode(
        JSON.stringify({
          action: "error",
          operationAction: "capture",
          message: "Private /home/path",
        }),
      ),
    });
    expect(
      await openCantripOsBackupResult(
        operationId,
        response as Parameters<typeof openCantripOsBackupResult>[1],
        options,
      ),
    ).toEqual({
      action: "error",
      operationAction: "capture",
      message: "Private /home/path",
    });
    await expect(
      openCantripOsBackupRequest(
        operationId,
        response as unknown as typeof frame,
        options,
      ),
    ).rejects.toThrow("could not be authenticated");
  } finally {
    clearSensitiveBytes(componentKey);
    clearSensitiveBytes(key);
  }
});

it("rejects another operation, server, account and locked key state", async () => {
  const { service, key, options } = fixture();
  try {
    const frame = await protectCantripOsBackupRequest(
      operationId,
      { action: "rollback", workspaceId, restoreOperationId: workspaceId },
      options,
    );
    await expect(
      openCantripOsBackupRequest(workspaceId, frame, options),
    ).rejects.toThrow("could not be authenticated");
    for (const other of [
      { ownerId: "other", serverId: identity.serverId },
      { ownerId: identity.ownerId, serverId: "other" },
    ]) {
      service.setAccountMasterKey({
        accountMasterKey: key,
        identity: other,
        masterKeyRevision: 1,
      });
      await expect(
        openCantripOsBackupRequest(operationId, frame, {
          service,
          session: () =>
            ({
              serverId: other.serverId,
              user: { id: other.ownerId },
            }) as ClientSessionContext,
        }),
      ).rejects.toThrow("could not be authenticated");
    }
    service.lock();
    await expect(
      openCantripOsBackupRequest(operationId, frame, options),
    ).rejects.toThrow("Unlock encryption");
  } finally {
    clearSensitiveBytes(key);
  }
});

it("does not return plaintext if the account changes during authenticated decryption", async () => {
  const { service, key, options } = fixture();
  try {
    const frame = await protectCantripOsBackupRequest(
      operationId,
      { action: "capture", workspaceId, label: "private", exclusions: [] },
      options,
    );
    const pending = openCantripOsBackupRequest(operationId, frame, options);
    service.lock();
    await expect(pending).rejects.toThrow();
  } finally {
    clearSensitiveBytes(key);
  }
});
