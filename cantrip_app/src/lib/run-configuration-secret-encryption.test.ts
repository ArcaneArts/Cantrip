import { generateAccountMasterKey } from "@cantrip/crypto";
import { describe, expect, it } from "vitest";

import { ClientEncryptionService } from "./client-encryption";
import type { ClientSessionContext } from "./client-session";
import { protectRunConfigurationSecretValue } from "./run-configuration-secret-encryption";

const ownerId = "run-secret-owner";
const serverId = "run-secret-server";
const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";

function unlockedOptions() {
  const service = new ClientEncryptionService();
  service.setAccountMasterKey({
    accountMasterKey: generateAccountMasterKey(),
    identity: { ownerId, serverId },
    masterKeyRevision: 4,
  });
  return {
    service,
    session: () =>
      ({ serverId, user: { id: ownerId } }) as ClientSessionContext,
  };
}

describe("Run configuration secret encryption", () => {
  it("produces write-only ciphertext bound to the project and reference", async () => {
    const value = "secret-plaintext-sentinel";
    const protectedValue = await protectRunConfigurationSecretValue({
      projectId,
      reference: "project/database-url",
      value,
      options: unlockedOptions(),
    });

    expect(protectedValue.keyRevision).toBe(4);
    expect(JSON.stringify(protectedValue)).not.toContain(value);
    await expect(
      protectRunConfigurationSecretValue({
        projectId,
        reference: "project/../database-url",
        value,
        options: unlockedOptions(),
      }),
    ).rejects.toThrow();
  });
});
