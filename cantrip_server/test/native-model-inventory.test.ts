import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { eq } from "drizzle-orm";
import { migrate } from "drizzle-orm/pglite/migrator";
import Fastify from "fastify";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  resolveNativeModelSelection,
  type NativeModelInventoryRequest,
} from "@cantrip/protocol";
import {
  LOCAL_USER_ID,
  ServerRepository,
  type ProviderModelCatalogWrite,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { readNativeModelInventory } from "../src/models/native-model-inventory.js";
import { installInternalNativeModelInventoryRoutes } from "../src/app/routes/internal-native-model-inventory.js";
import { createApplicationOwnerContext } from "../src/app/http/owner-context.js";
import type { ServerConfig } from "../src/config.js";
import { protectedSecretEnvelopeFixture } from "./protected-provider-credential-fixture.js";
import { NativeModelInventoryClient } from "../../cantrip_worker/src/native-model-inventory-client.js";

const client = new PGlite();
const database = drizzle(client, { schema });
const repository = new ServerRepository(
  database,
  new SecretVault({
    activeKeyId: "test",
    keys: [{ id: "test", key: Buffer.alloc(32, 19) }],
  }),
);
const owner = LOCAL_USER_ID;
const workerId = "inventory-worker";
const config = {
  deploymentMode: "local",
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  host: "127.0.0.1",
  workerToken: "inventory-test-token",
} as ServerConfig;
const catalogModel = (nativeModelId: string): ProviderModelCatalogWrite => ({
  nativeModelId,
  canonicalModelId: nativeModelId,
  displayName: nativeModelId,
  description: null,
  contextWindow: null,
  maxOutputTokens: null,
  inputModalities: ["text"],
  outputModalities: ["text"],
  supportsTools: null,
  supportsParallelTools: null,
  supportsStructuredOutput: null,
  supportsVision: null,
  supportsReasoning: null,
  supportedReasoningEfforts: [],
  defaultReasoningEffort: null,
  reasoningMandatory: null,
  family: null,
  parameterSize: null,
  quantization: null,
  digest: null,
  metadataSource: "codex",
  matchConfidenceBasisPoints: null,
  rawMetadata: {},
});
const names = async (scope: NativeModelInventoryRequest) =>
  (await readNativeModelInventory(repository, owner, scope))?.models.map(
    (model) => model.name,
  );

beforeAll(async () => {
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await repository.ensureLocalIdentity();
  await repository.ensureAccountConfiguration(owner);
  await database.insert(schema.workers).values(
    [workerId, "different-worker"].map((id) => ({
      id,
      ownerId: owner,
      name: "Fixture",
      platform: "darwin",
      architecture: "arm64",
      startedAt: new Date(),
      lastSeenAt: new Date(),
    })),
  );
}, 30_000);
afterAll(async () => {
  await client.close();
});

describe("managed native model inventory", () => {
  it("enumerates enabled routes only in the selected provider and preserves alias identity", async () => {
    const provider = await repository.createModelProvider(owner, {
      name: "Fixture",
      kind: "openai-compatible",
      baseUrl: "https://fixture.invalid/v1",
      protectedApiKey: protectedSecretEnvelopeFixture("Z"),
    });
    const other = await repository.createModelProvider(owner, {
      name: "Other",
      kind: "openai-compatible",
      baseUrl: "https://other.invalid/v1",
    });
    const first = await repository.createModelProfile(owner, {
      name: "Alias one",
      routes: [
        {
          providerId: provider.id,
          modelName: "shared-native-name",
          enabled: true,
        },
        {
          providerId: other.id,
          modelName: "other-provider-name",
          enabled: true,
        },
        { providerId: provider.id, modelName: "disabled", enabled: false },
      ],
    });
    await repository.createModelProfile(owner, {
      name: "Alias two",
      routes: [
        {
          providerId: provider.id,
          modelName: "shared-native-name",
          enabled: true,
        },
      ],
    });
    await repository.createModelProfile(owner, {
      name: "Custom",
      routes: [
        {
          providerId: provider.id,
          modelName: "custom-no-metadata",
          enabled: true,
        },
      ],
    });
    const scope = {
      workerId,
      providerId: provider.id,
      providerAccountId: null,
    };
    const getRuntimes = vi.spyOn(repository, "getModelRuntimes");
    const getCatalog = vi.spyOn(repository, "getProviderModelCatalog");
    const inventory = await readNativeModelInventory(repository, owner, scope);
    expect(inventory?.models.map((model) => model.name)).toEqual([
      "custom-no-metadata",
      "shared-native-name",
      "shared-native-name",
    ]);
    expect(getRuntimes).toHaveBeenCalledExactlyOnceWith(
      owner,
      undefined,
      undefined,
      false,
      provider.id,
    );
    expect(getCatalog).toHaveBeenCalledExactlyOnceWith(owner, provider.id);
    getRuntimes.mockRestore();
    getCatalog.mockRestore();
    expect(
      resolveNativeModelSelection(inventory!, "shared-native-name").status,
    ).toBe("ambiguous");
    const selected = inventory!.models.find((model) => model.id === first!.id)!;
    expect(
      resolveNativeModelSelection(inventory!, selected.name, selected.routeId),
    ).toEqual({ status: "resolved", model: selected });
    expect(
      resolveNativeModelSelection(inventory!, "custom-no-metadata").status,
    ).toBe("resolved");
    expect(
      resolveNativeModelSelection(inventory!, "other-provider-name"),
    ).toEqual({ status: "unmapped" });
    expect(JSON.stringify(inventory)).not.toMatch(
      /protectedApiKey|ciphertext|baseUrl|profileName/,
    );
    expect(
      await readNativeModelInventory(repository, "another-owner", scope),
    ).toBeNull();
    expect(
      await readNativeModelInventory(repository, owner, {
        ...scope,
        providerAccountId: "wrong-account",
      }),
    ).toBeNull();

    const app = Fastify();
    installInternalNativeModelInventoryRoutes(app, {
      config,
      repository,
      runAsOwner: createApplicationOwnerContext("none").runAsOwner,
    });
    try {
      const url = "/api/internal/native-model-inventory";
      expect(
        (await app.inject({ method: "POST", url, payload: scope })).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "POST",
            url,
            headers: { authorization: `Bearer ${config.workerToken}` },
            payload: { ...scope, workerId: "unknown-worker" },
          })
        ).statusCode,
      ).toBe(404);
      const inventoryClient = new NativeModelInventoryClient({
        serverUrl: "http://fixture.invalid",
        workerId,
        token: () => config.workerToken,
        fetch: async (input, init) => {
          const response = await app.inject({
            method: "POST",
            url: new URL(String(input)).pathname,
            headers: init!.headers as Record<string, string>,
            payload: init!.body as string,
          });
          return new Response(response.body, { status: response.statusCode });
        },
      });
      expect(
        await inventoryClient.read({
          id: provider.id,
          kind: provider.kind,
          accountId: null,
        }),
      ).toEqual(inventory);
    } finally {
      await app.close();
    }
  });

  it("uses the exact enabled account and worker, with global observations taking precedence", async () => {
    const accountId = randomUUID();
    const provider = await repository.createModelProvider(owner, {
      id: randomUUID(),
      name: "Account provider",
      kind: "chatgpt",
      baseUrl: "https://fixture.invalid/responses",
      initialAccount: {
        id: accountId,
        protectedLabel: protectedSecretEnvelopeFixture("Y"),
      },
    });
    const second = await repository.createModelProviderAccount(
      owner,
      provider.id,
      { id: randomUUID(), protectedLabel: protectedSecretEnvelopeFixture("X") },
    );
    const models = [
      "global",
      "worker-only",
      "other-account",
      "other-worker",
    ].map(catalogModel);
    const reconcile = (
      account: string,
      worker: string | null,
      available: string[],
    ) =>
      repository.reconcileProviderModelCatalog(owner, provider.id, {
        models,
        availabilityScope: `${account}:${worker ?? "global"}`,
        availabilityProviderAccountId: account,
        availabilityWorkerId: worker,
        availableNativeModelIds: new Set(available),
        autoCreateLogicalModels: true,
      });
    await reconcile(accountId, workerId, ["global", "worker-only"]);
    // All model observations exist in this global scope: its unavailable
    // worker-only observation overrides the older worker-local availability.
    await reconcile(accountId, null, ["global"]);
    await reconcile(second!.id, null, ["other-account"]);
    await repository.createModelProfile(owner, {
      name: "Explicit custom",
      routes: [{ providerId: provider.id, modelName: "custom", enabled: true }],
    });
    const scope = {
      workerId,
      providerId: provider.id,
      providerAccountId: accountId,
    };
    expect(await names(scope)).toEqual(["custom", "global"]);
    expect(await names({ ...scope, providerAccountId: second!.id })).toEqual([
      "custom",
      "other-account",
    ]);
    expect(await names({ ...scope, providerAccountId: null })).toBeUndefined();
    expect(
      await names({ ...scope, providerAccountId: "unknown" }),
    ).toBeUndefined();
    await database
      .update(schema.modelProviderAccounts)
      .set({ enabled: false })
      .where(eq(schema.modelProviderAccounts.id, second!.id));
    expect(
      await names({ ...scope, providerAccountId: second!.id }),
    ).toBeUndefined();
    // A discovered model available only on another worker is not eligible.
    const third = await repository.createModelProviderAccount(
      owner,
      provider.id,
      { id: randomUUID(), protectedLabel: protectedSecretEnvelopeFixture("W") },
    );
    await reconcile(third!.id, "different-worker", ["other-worker"]);
    expect(await names({ ...scope, providerAccountId: third!.id })).toEqual([
      "custom",
    ]);
    expect(
      await names({
        ...scope,
        workerId: "different-worker",
        providerAccountId: third!.id,
      }),
    ).toEqual(["custom", "other-worker"]);
  });

  it("keeps Ollama discovery specific to the selected worker", async () => {
    const provider = await repository.createModelProvider(owner, {
      name: "Worker scoped",
      kind: "ollama",
      baseUrl: "http://127.0.0.1:11434/v1",
    });
    await repository.reconcileProviderModelCatalog(owner, provider.id, {
      models: [catalogModel("worker-model")],
      availabilityScope: `worker:${workerId}`,
      availabilityWorkerId: workerId,
      availableNativeModelIds: new Set(["worker-model"]),
      autoCreateLogicalModels: true,
    });
    expect(
      await names({
        workerId,
        providerId: provider.id,
        providerAccountId: null,
      }),
    ).toEqual(["worker-model"]);
    expect(
      await names({
        workerId: "different-worker",
        providerId: provider.id,
        providerAccountId: null,
      }),
    ).toEqual([]);
  });
});
