import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { unprobedCodexRuntimeReport } from "@cantrip/protocol";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  isZaiCodingPlanProvider,
  ZAI_CODEX_CATALOG_SCOPE,
  ZAI_CODEX_CATALOG_VERSION,
  ZAI_CODEX_MODELS,
  ZaiCatalogService,
} from "../src/models/zai-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function setup() {
  const client = new PGlite();
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 23) }],
    }),
  );
  await repository.ensureLocalIdentity();
  await repository.ensureDefaultModelConfiguration(
    LOCAL_USER_ID,
    "gemma4:12b",
    "http://127.0.0.1:11434/v1",
  );
  return { client, database, repository };
}

describe("Z.ai Coding Plan catalog", () => {
  it("detects the canonical Responses provider family", () => {
    expect(
      isZaiCodingPlanProvider({
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1/responses",
      }),
    ).toBe(true);
    expect(
      isZaiCodingPlanProvider({
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/coding/paas/v4",
      }),
    ).toBe(false);
  });

  it("ships the documented versioned Codex metadata", () => {
    expect(ZAI_CODEX_CATALOG_VERSION).toBe(1);
    expect(ZAI_CODEX_MODELS).toEqual([
      expect.objectContaining({
        nativeModelId: "glm-5.3",
        contextWindow: 1_048_576,
        inputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: true,
        supportsVision: false,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [
          expect.objectContaining({ effort: "low" }),
          expect.objectContaining({ effort: "high" }),
          expect.objectContaining({ effort: "max" }),
        ],
        metadataSource: "zai",
        isDefault: true,
        rawMetadata: expect.objectContaining({
          applyPatchToolType: "freeform",
          contextWindowPercent: 95,
          catalogVersion: 1,
        }),
      }),
      expect.objectContaining({
        nativeModelId: "glm-5-turbo",
        contextWindow: 204_800,
        inputModalities: ["text"],
        supportsTools: true,
        supportsParallelTools: true,
        supportsVision: false,
        defaultReasoningEffort: "max",
        supportedReasoningEfforts: [],
        metadataSource: "zai",
        rawMetadata: expect.objectContaining({
          applyPatchToolType: "freeform",
          contextWindowPercent: 95,
          catalogVersion: 1,
        }),
      }),
    ]);
  });

  it("creates discovery-managed routes and preserves user customization", async () => {
    const { client, database, repository } = await setup();
    try {
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Existing Z.ai",
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1/responses",
        apiKey: "secret-coding-plan-key",
      });
      const service = new ZaiCatalogService(repository);
      const first = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
      );
      expect(
        first?.models.map(({ nativeModelId }) => nativeModelId).sort(),
      ).toEqual(["glm-5-turbo", "glm-5.3"]);
      expect(first?.availability).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            scopeKey: ZAI_CODEX_CATALOG_SCOPE,
            state: "available",
            workerId: null,
          }),
        ]),
      );

      const settings = await repository.getSettings(LOCAL_USER_ID);
      const discovered = settings.models.find(({ name }) => name === "glm-5.3");
      expect(discovered).toMatchObject({
        discoveryManaged: true,
        routes: [
          expect.objectContaining({
            discoveryManaged: true,
            modelName: "glm-5.3",
            providerId: provider.id,
          }),
        ],
      });

      await database
        .update(schema.modelProfiles)
        .set({ name: "My GLM flagship", discoveryManaged: false })
        .where(eq(schema.modelProfiles.id, discovered!.id));
      await service.getProviderCatalog(LOCAL_USER_ID, provider.id);
      const refreshed = await repository.getSettings(LOCAL_USER_ID);
      expect(
        refreshed.models.find(({ id }) => id === discovered!.id),
      ).toMatchObject({
        name: "My GLM flagship",
        discoveryManaged: false,
        routes: [expect.objectContaining({ modelName: "glm-5.3" })],
      });
    } finally {
      await client.close();
    }
  });

  it("migrates existing providers without changing mixed routes or resumed chats", async () => {
    const { client, database, repository } = await setup();
    const secret = "existing-zai-coding-plan-secret";
    try {
      const fallback = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Compatible fallback",
        kind: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        apiKey: "fallback-secret",
      });
      const zaiPrimary = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Existing Z.ai primary",
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1/responses",
        apiKey: secret,
      });
      const zaiSecondary = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Existing Z.ai secondary",
        kind: "openai-compatible",
        baseUrl: "https://api.z.ai/api/v1",
        apiKey: "secondary-secret",
      });
      const logicalModel = await repository.createModelProfile(LOCAL_USER_ID, {
        name: "Portable GLM",
        routes: [
          {
            providerId: fallback.id,
            modelName: "fallback-model",
            enabled: true,
          },
          {
            providerId: zaiPrimary.id,
            modelName: "glm-5.3",
            enabled: true,
          },
          {
            providerId: zaiSecondary.id,
            modelName: "glm-5-turbo",
            enabled: true,
          },
        ],
      });
      if (!logicalModel) throw new Error("Could not create logical model.");
      const originalRoutes = logicalModel.routes.map((route) => ({
        id: route.id,
        providerId: route.providerId,
        modelName: route.modelName,
        enabled: route.enabled,
      }));

      await repository.recordWorker(LOCAL_USER_ID, {
        workerId: "zai-worker",
        name: "Z.ai Worker",
        platform: "darwin",
        architecture: "arm64",
        codexVersion: "0.148.0",
        codexRuntime: unprobedCodexRuntimeReport,
        remoteSurfaces: {
          browser: false,
          transports: ["websocket"],
          maxSessions: 1,
        },
        startedAt: new Date().toISOString(),
      });
      const project = await repository.createGithubProject(LOCAL_USER_ID, {
        workerId: "zai-worker",
        ...protectedProjectFields(),
        repositoryId: "zai-migration-repository",
        nameWithOwner: "ArcaneArts/ZaiMigration",
        url: "https://github.com/ArcaneArts/ZaiMigration",
      });
      await repository.completeGithubProjectSetup(
        LOCAL_USER_ID,
        project.id,
        "zai-worker",
        {
          path: "/tmp/cantrip-zai-migration",
          displayPath: "ArcaneArts/ZaiMigration",
          reused: false,
          updated: false,
          warning: null,
        },
      );
      const chat = await repository.createChat(LOCAL_USER_ID, project.id, {
        ...protectedChatFields(),
        worktreeMode: "agent-managed",
      });
      if (!chat) throw new Error("Could not create chat.");
      await repository.setChatModel(LOCAL_USER_ID, chat.id, {
        modelId: logicalModel.id,
      });
      const context = await repository.getChatExecutionContext(
        LOCAL_USER_ID,
        chat.id,
      );
      if (!context) throw new Error("Could not resolve chat context.");
      await repository.updateChatRuntime(
        chat.id,
        context.workerId,
        context.worktreeId,
        "thread-existing-zai",
        logicalModel.routes[1]!.id,
      );

      const reconciled = await new ZaiCatalogService(
        repository,
      ).reconcileOwnerProviders(LOCAL_USER_ID);
      expect(reconciled.sort()).toEqual(
        [zaiPrimary.id, zaiSecondary.id].sort(),
      );

      const settings = await repository.getSettings(LOCAL_USER_ID);
      expect(settings.providers.map(({ id }) => id)).toEqual(
        expect.arrayContaining([zaiPrimary.id, zaiSecondary.id]),
      );
      expect(JSON.stringify(settings)).not.toContain(secret);
      const storedProvider = await database
        .select()
        .from(schema.modelProviders)
        .where(eq(schema.modelProviders.id, zaiPrimary.id));
      expect(storedProvider[0]?.apiKeyEnvelope).toBeTruthy();
      expect(JSON.stringify(storedProvider[0]?.apiKeyEnvelope)).not.toContain(
        secret,
      );

      const preserved = settings.models.find(
        ({ id }) => id === logicalModel.id,
      );
      expect(
        preserved?.routes.map((route) => ({
          id: route.id,
          providerId: route.providerId,
          modelName: route.modelName,
          enabled: route.enabled,
        })),
      ).toEqual(originalRoutes);
      expect(
        (await repository.getModelRuntimes(LOCAL_USER_ID, logicalModel.id)).map(
          ({ provider, model }) => ({
            providerId: provider.id,
            modelName: model.name,
          }),
        ),
      ).toEqual(
        originalRoutes.map(({ providerId, modelName }) => ({
          providerId,
          modelName,
        })),
      );
      expect(
        await repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
      ).toMatchObject({
        modelId: logicalModel.id,
        modelRouteId: logicalModel.routes[1]!.id,
        threadId: "thread-existing-zai",
      });
    } finally {
      await client.close();
    }
  });
});
