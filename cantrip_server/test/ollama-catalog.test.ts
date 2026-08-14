import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  normalizeOllamaModel,
  OllamaCatalogService,
} from "../src/models/ollama-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const gemma = {
  name: "gemma4:12b",
  modifiedAt: "2026-08-14T12:00:00.000Z",
  sizeBytes: 7_000_000_000,
  digest: "sha256:gemma4",
  family: "gemma4",
  families: ["gemma4"],
  parameterSize: "12B",
  quantization: "Q4_K_M",
  capabilities: ["completion", "tools", "thinking", "vision"],
  modelInfo: {
    "general.architecture": "gemma4",
    "gemma4.context_length": 131_072,
  },
};

const qwen = {
  ...gemma,
  name: "qwen3:8b",
  digest: "sha256:qwen3",
  family: "qwen3",
  families: ["qwen3"],
  parameterSize: "8B",
  capabilities: ["completion", "tools"],
  modelInfo: {
    "general.architecture": "qwen3",
    "qwen3.context_length": 32_768,
  },
};

describe("Ollama catalog", () => {
  it("derives worker-local capability metadata", () => {
    expect(normalizeOllamaModel(gemma)).toMatchObject({
      nativeModelId: "gemma4:12b",
      canonicalModelId: null,
      contextWindow: 131_072,
      inputModalities: ["text", "image"],
      supportsTools: true,
      supportsStructuredOutput: true,
      supportsVision: true,
      supportsReasoning: true,
      family: "gemma4",
      parameterSize: "12B",
      quantization: "Q4_K_M",
    });
  });

  it("auto-creates safe models, preserves missing models, and honors deletion suppressions", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    let inventory = [gemma, qwen];
    const commands: unknown[] = [];
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async (_workerId, command) => {
        commands.push(command);
        return {
          models: inventory,
          observedAt: "2026-08-14T12:00:00.000Z",
        };
      },
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
    } satisfies WorkerCommandBus;
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 9) }],
        }),
      );
      await repository.ensureLocalIdentity();
      await client.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', '${LOCAL_USER_ID}', 'Local Worker', 'darwin', 'arm64',
          now(), now()
        );
      `);
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Ollama",
        kind: "ollama",
        baseUrl: "http://127.0.0.1:11434/v1",
      });
      const service = new OllamaCatalogService(repository, bridge);

      let catalog = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      expect(catalog?.models).toHaveLength(2);
      expect(catalog?.availability).toEqual([
        expect.objectContaining({
          scopeKey: "worker:worker-1",
          state: "available",
        }),
        expect.objectContaining({
          scopeKey: "worker:worker-1",
          state: "available",
        }),
      ]);
      let profiles = await client.query<{
        discovery_managed: boolean;
        id: string;
        name: string;
      }>(`
        SELECT id, name, discovery_managed
        FROM model_profiles
        ORDER BY name
      `);
      expect(profiles.rows).toEqual([
        expect.objectContaining({
          name: "gemma4:12b",
          discovery_managed: true,
        }),
        expect.objectContaining({ name: "qwen3:8b", discovery_managed: true }),
      ]);
      const gemmaProfile = profiles.rows.find(
        ({ name }) => name === "gemma4:12b",
      );
      expect(
        await repository.getModelRuntime(LOCAL_USER_ID, gemmaProfile!.id),
      ).toMatchObject({
        model: {
          providerModelId: expect.any(String),
          catalog: {
            nativeModelId: "gemma4:12b",
            contextWindow: 131_072,
            supportsTools: true,
            supportsVision: true,
          },
        },
      });
      await client.exec(`
        UPDATE model_routes SET provider_model_id = NULL
        WHERE model_id = '${gemmaProfile!.id}'
      `);
      await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      expect(
        (await repository.getModelRuntime(LOCAL_USER_ID, gemmaProfile!.id))
          ?.model.providerModelId,
      ).toEqual(expect.any(String));

      inventory = [gemma];
      catalog = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      expect(catalog?.models).toHaveLength(2);
      expect(
        catalog?.availability.filter(({ state }) => state === "unavailable"),
      ).toHaveLength(1);

      expect(
        await repository.deleteModelProfile(LOCAL_USER_ID, gemmaProfile!.id),
      ).toBe(true);
      await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      profiles = await client.query<{
        discovery_managed: boolean;
        id: string;
        name: string;
      }>(`
        SELECT id, name, discovery_managed
        FROM model_profiles
        ORDER BY name
      `);
      expect(profiles.rows.map(({ name }) => name)).toEqual(["qwen3:8b"]);
      expect(commands).toHaveLength(4);
      expect(commands[0]).toMatchObject({
        type: "model.ollama.catalog",
        baseUrl: "http://127.0.0.1:11434/v1",
      });
    } finally {
      await client.close();
    }
  });
});
