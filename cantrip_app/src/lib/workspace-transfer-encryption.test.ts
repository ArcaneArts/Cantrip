import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";
import { ClientEncryptionService } from "./client-encryption";
import {
  decryptWorkspaceTransfer,
  encryptWorkspaceTransfer,
  type WorkspaceTransferBinding,
} from "./workspace-transfer-encryption";

const binding: WorkspaceTransferBinding = {
  serverId: "server",
  ownerId: "owner",
  projectId: "project",
  workspaceId: "device-workspace",
  transferId: "transfer",
  sourceWindowId: "main",
  sourceGeneration: 2,
  destinationWindowId: "destination",
  destinationGeneration: 3,
  purpose: "snapshot",
};
function unlocked(key = generateAccountMasterKey()) {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: key,
    identity: binding,
    masterKeyRevision: 1,
  });
  return service;
}
const content = new TextEncoder().encode("private unsaved source code");

describe("protected workspace handoff", () => {
  it("captures bytes before asynchronous encryption rather than retaining a mutable buffer", async () => {
    const service = unlocked();
    const bytes = new Uint8Array(content);
    const pending = encryptWorkspaceTransfer(binding, bytes, service);
    bytes.fill(0);
    const opaque = await pending;
    expect(await decryptWorkspaceTransfer(binding, opaque, service)).toEqual(
      content,
    );
  });

  it("rejects invalid generations and a stale account key revision", async () => {
    const service = unlocked();
    await expect(
      encryptWorkspaceTransfer(
        { ...binding, sourceGeneration: -1 },
        content,
        service,
      ),
    ).rejects.toThrow(/binding/);
    await expect(
      encryptWorkspaceTransfer(
        { ...binding, transferId: "" },
        content,
        service,
      ),
    ).rejects.toThrow(/binding/);
    const opaque = await encryptWorkspaceTransfer(binding, content, service);
    await expect(
      decryptWorkspaceTransfer(binding, { ...opaque, keyRevision: 2 }, service),
    ).rejects.toThrow(/key revision/);
  });

  it("round-trips between account renderers without exposing plaintext in the envelope", async () => {
    const key = generateAccountMasterKey();
    const source = unlocked(key);
    const destination = unlocked(key);
    const opaque = await encryptWorkspaceTransfer(binding, content, source);
    expect(JSON.stringify(opaque)).not.toContain("private unsaved");
    expect(
      await decryptWorkspaceTransfer(binding, opaque, destination),
    ).toEqual(content);
    expect(content).toEqual(
      new TextEncoder().encode("private unsaved source code"),
    );
  });

  it.each(Object.keys(binding) as (keyof WorkspaceTransferBinding)[])(
    "authenticates binding field %s",
    async (field) => {
      const service = unlocked();
      const opaque = await encryptWorkspaceTransfer(binding, content, service);
      const original = binding[field];
      const changed = {
        ...binding,
        [field]:
          typeof original === "number"
            ? original + 1
            : field === "purpose"
              ? "restored"
              : `${original}-other`,
      };
      await expect(
        decryptWorkspaceTransfer(changed, opaque, service),
      ).rejects.toThrow();
    },
  );

  it("rejects locked services, tampered ciphertext and an unrelated account key", async () => {
    await expect(
      encryptWorkspaceTransfer(binding, content, new ClientEncryptionService()),
    ).rejects.toThrow();
    const service = unlocked();
    const opaque = await encryptWorkspaceTransfer(binding, content, service);
    await expect(
      decryptWorkspaceTransfer(binding, opaque, unlocked()),
    ).rejects.toThrow();
    const ciphertext =
      (opaque.ciphertext[0] === "A" ? "B" : "A") + opaque.ciphertext.slice(1);
    await expect(
      decryptWorkspaceTransfer(binding, { ...opaque, ciphertext }, service),
    ).rejects.toThrow();
  });

  it("does not return output when encryption locks during asynchronous capture", async () => {
    const service = unlocked();
    const pending = encryptWorkspaceTransfer(binding, content, service);
    service.lock();
    await expect(pending).rejects.toThrow(/identity changed/);
  });

  it("does not expose decoded state after a lock during decryption", async () => {
    const service = unlocked();
    const opaque = await encryptWorkspaceTransfer(binding, content, service);
    const pending = decryptWorkspaceTransfer(binding, opaque, service);
    service.lock();
    await expect(pending).rejects.toThrow(/identity changed/);
  });
});
