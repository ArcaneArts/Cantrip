import { encryptProtectedSecret, randomBytes } from "@cantrip/crypto";
import {
  mcpServerConfigurationSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { providerApiKeyProtectedContentSchema } from "@cantrip/protocol/protected-secrets";
import { describe, expect, it } from "vitest";

import {
  openMcpServers,
  openRuntimeProvider,
} from "../src/protected-secrets.js";
import type { WorkerEncryptionService } from "../src/worker-encryption.js";

const ownerId = "owner-worker-secret";
const providerId = "00000000-0000-4000-8000-000000000911";
const mcpId = "00000000-0000-4000-8000-000000000912";

describe("worker protected secret boundary", () => {
  it("opens provider and MCP payloads only with granted component keys", async () => {
    const providerKey = randomBytes(32);
    const mcpKey = randomBytes(32);
    const service = {
      componentKey(component: "provider-credential" | "mcp-secret") {
        return {
          key: new Uint8Array(
            component === "provider-credential" ? providerKey : mcpKey,
          ),
          keyRevision: 1,
        };
      },
      ownerId: () => ownerId,
    } as WorkerEncryptionService;
    const protectedApiKey = await encryptProtectedSecret({
      ownerId,
      component: "provider-credential",
      table: "model_providers",
      rowId: providerId,
      field: "protected_api_key",
      keyRevision: 1,
      componentKey: providerKey,
      content: { version: 1, apiKey: "worker-only-api-key" },
      contentSchema: providerApiKeyProtectedContentSchema,
    });
    const provider = {
      id: providerId,
      name: "Private provider",
      kind: "openai-compatible",
      baseUrl: "https://provider.example.test/v1",
      protectedApiKey,
      accountId: null,
      credentialHomeKey: null,
    } satisfies Extract<WorkerCommand, { type: "chat.turn" }>["provider"];
    const configuration = mcpServerConfigurationSchema.parse({
      name: "private_mcp",
      enabled: true,
      transport: "http",
      url: "https://mcp.example.test/private",
      bearerTokenEnvironmentVariable: null,
      headers: { authorization: "Bearer mcp-secret" },
      environmentHeaders: {},
    });
    const protectedConfiguration = await encryptProtectedSecret({
      ownerId,
      component: "mcp-secret",
      table: "mcp_servers",
      rowId: mcpId,
      field: "protected_configuration",
      keyRevision: 1,
      componentKey: mcpKey,
      content: configuration,
      contentSchema: mcpServerConfigurationSchema,
    });

    await expect(
      openRuntimeProvider({ provider, service }),
    ).resolves.toMatchObject({
      apiKey: "worker-only-api-key",
      protectedApiKey,
    });
    await expect(
      openMcpServers({
        servers: [
          {
            id: mcpId,
            enabled: true,
            nameBlindIndex: "A".repeat(43),
            protectedConfiguration,
          },
        ],
        service,
      }),
    ).resolves.toEqual([configuration]);
  });
});
