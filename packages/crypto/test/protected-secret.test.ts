import { providerApiKeyProtectedContentSchema } from "@cantrip/protocol/protected-secrets";
import { describe, expect, it } from "vitest";

import {
  CantripDecryptionError,
  decryptProtectedSecret,
  encryptProtectedSecret,
  randomBytes,
} from "../src/index.js";

const ownerId = "owner-protected-secret";
const providerId = "00000000-0000-4000-8000-000000000901";

describe("protected provider secrets", () => {
  it("round-trips without exposing plaintext and binds the ciphertext to its row", async () => {
    const componentKey = randomBytes(32);
    const encrypted = await encryptProtectedSecret({
      ownerId,
      component: "provider-credential",
      table: "model_providers",
      rowId: providerId,
      field: "protected_api_key",
      keyRevision: 3,
      componentKey,
      content: { version: 1, apiKey: "sentinel-provider-api-key" },
      contentSchema: providerApiKeyProtectedContentSchema,
    });

    expect(JSON.stringify(encrypted)).not.toContain(
      "sentinel-provider-api-key",
    );
    await expect(
      decryptProtectedSecret({
        ownerId,
        component: "provider-credential",
        table: "model_providers",
        rowId: providerId,
        field: "protected_api_key",
        keyRevision: 3,
        componentKey,
        encrypted,
        contentSchema: providerApiKeyProtectedContentSchema,
      }),
    ).resolves.toEqual({ version: 1, apiKey: "sentinel-provider-api-key" });

    await expect(
      decryptProtectedSecret({
        ownerId,
        component: "provider-credential",
        table: "model_providers",
        rowId: "00000000-0000-4000-8000-000000000902",
        field: "protected_api_key",
        keyRevision: 3,
        componentKey,
        encrypted,
        contentSchema: providerApiKeyProtectedContentSchema,
      }),
    ).rejects.toBeInstanceOf(CantripDecryptionError);
  });
});
