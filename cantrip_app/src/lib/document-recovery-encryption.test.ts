import { generateAccountMasterKey } from "@cantrip/crypto";
import { expect, it } from "vitest";
import { ClientEncryptionService } from "./client-encryption";
import {
  documentRecoveryKey,
  encryptDocumentRecovery,
  decryptDocumentRecovery,
  type DocumentRecoveryBinding,
} from "./document-recovery-encryption";

const binding: DocumentRecoveryBinding = {
  serverId: "server",
  ownerId: "owner",
  workspaceId: "workspace",
  projectId: "project",
  workerId: "worker",
  worktreeId: "worktree",
  documentId: "opaque-document",
  tabId: "tab",
};
function unlocked() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: binding,
    masterKeyRevision: 1,
  });
  return service;
}

it("captures immutable plaintext and authenticates its recovery revision", async () => {
  const service = unlocked();
  const bytes = new TextEncoder().encode("private draft");
  const pending = encryptDocumentRecovery(binding, 1, bytes, service);
  bytes.fill(0);
  const opaque = await pending;
  expect(JSON.stringify(opaque)).not.toContain("private draft");
  expect(
    new TextDecoder().decode(
      await decryptDocumentRecovery(binding, 1, opaque, service),
    ),
  ).toBe("private draft");
  await expect(
    decryptDocumentRecovery(binding, 2, opaque, service),
  ).rejects.toThrow();
});

it.each(Object.keys(binding) as (keyof DocumentRecoveryBinding)[])(
  "authenticates %s and scopes the storage key",
  async (field) => {
    const service = unlocked();
    const opaque = await encryptDocumentRecovery(
      binding,
      1,
      new Uint8Array([1]),
      service,
    );
    const changed = { ...binding, [field]: `${binding[field]}-different` };
    expect(await documentRecoveryKey(changed)).not.toBe(
      await documentRecoveryKey(binding),
    );
    await expect(
      decryptDocumentRecovery(changed, 1, opaque, service),
    ).rejects.toThrow();
  },
);

it("reports locked encryption and invalid bindings instead of returning empty content", async () => {
  await expect(
    encryptDocumentRecovery(
      binding,
      1,
      new Uint8Array(),
      new ClientEncryptionService(),
    ),
  ).rejects.toThrow();
  await expect(
    documentRecoveryKey({ ...binding, documentId: "" }),
  ).rejects.toThrow(/binding/);
  await expect(
    encryptDocumentRecovery(binding, 0, new Uint8Array(), unlocked()),
  ).rejects.toThrow(/revision/);
});

it("rejects a stored checkpoint after logout", async () => {
  const service = unlocked();
  const opaque = await encryptDocumentRecovery(
    binding,
    1,
    new Uint8Array([1]),
    service,
  );
  await expect(
    decryptDocumentRecovery(binding, 1, opaque, new ClientEncryptionService()),
  ).rejects.toThrow();
});

it("rejects encryption completed after the active account changes", async () => {
  const service = unlocked();
  const pending = encryptDocumentRecovery(
    binding,
    1,
    new Uint8Array([1]),
    service,
  );
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { serverId: binding.serverId, ownerId: "another-owner" },
    masterKeyRevision: 1,
  });
  await expect(pending).rejects.toThrow(/identity changed/);
});

it("does not silently decrypt an obsolete account-key revision", async () => {
  const service = unlocked();
  const opaque = await encryptDocumentRecovery(
    binding,
    1,
    new Uint8Array([1]),
    service,
  );
  await expect(
    decryptDocumentRecovery(binding, 1, { ...opaque, keyRevision: 2 }, service),
  ).rejects.toThrow(/key revision/);
});
