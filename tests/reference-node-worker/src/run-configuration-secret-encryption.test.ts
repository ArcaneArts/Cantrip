import { encryptProtectedSecret, randomBytes } from "@cantrip/crypto";
import {
  runConfigurationSecretProtectionRowId,
  runConfigurationSecretValueContentSchema,
} from "@cantrip/protocol/run-configuration-secrets";
import { describe, expect, it } from "vitest";

import { openRunConfigurationSecretValue } from "./run-configuration-secret-encryption.js";

const ownerId = "run-secret-owner";
const projectId = "f288701f-e4a6-4d08-bd54-eddb41aadbe5";
const reference = "project/database-url";

describe("worker Run configuration secret encryption", () => {
  it("opens only ciphertext bound to the exact project and reference", async () => {
    const componentKey = randomBytes(32);
    const value = "secret-plaintext-sentinel";
    const protectedValue = await encryptProtectedSecret({
      ownerId,
      component: "run-content",
      table: "run_configuration_secrets",
      rowId: runConfigurationSecretProtectionRowId({ projectId, reference }),
      field: "protected_value",
      keyRevision: 2,
      componentKey,
      content: { version: 1, value },
      contentSchema: runConfigurationSecretValueContentSchema,
    });
    const service = {
      componentKey: () => ({ key: componentKey.slice(), keyRevision: 2 }),
      ownerId: () => ownerId,
    };
    const secret = { reference, revision: 7, protectedValue };

    expect(JSON.stringify(secret)).not.toContain(value);
    await expect(
      openRunConfigurationSecretValue({ projectId, secret, service }),
    ).resolves.toBe(value);
    await expect(
      openRunConfigurationSecretValue({
        projectId: "83a2cf62-b888-49ee-b1aa-1b4a31b4f03d",
        secret,
        service,
      }),
    ).rejects.toThrow();
  });
});
