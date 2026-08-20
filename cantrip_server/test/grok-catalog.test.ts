import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  enrichGrokCatalogVisionFromOpenRouter,
  GrokCatalogService,
  normalizeGrokCatalogModel,
} from "../src/models/grok-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const model = (id: string, isDefault = false) => ({
  id,
  displayName: id === "grok-4" ? "Grok 4" : id,
  description: `${id} from Grok`,
  contextWindow: 262_144,
  maxOutputTokens: 32_768,
  inputModalities: ["text", "image"],
  outputModalities: ["text"],
  supportedReasoningEfforts: [
    { effort: "low", description: "Fast" },
    { effort: "high", description: "Deep" },
  ],
  defaultReasoningEffort: "low",
  supportsReasoning: true,
  hidden: false,
  isDefault,
  rawMetadata: { id },
});

describe("Grok catalog", () => {
  it("normalizes advertised model metadata conservatively", () => {
    expect(normalizeGrokCatalogModel(model("grok-4", true))).toMatchObject({
      nativeModelId: "grok-4",
      canonicalModelId: "grok-4",
      displayName: "Grok 4",
      inputModalities: ["text", "image"],
      supportsVision: true,
      supportsReasoning: true,
      supportsTools: true,
      supportsStructuredOutput: null,
      metadataSource: "grok",
      isDefault: true,
    });
  });

  it("fills omitted Grok vision metadata from one exact public model", () => {
    const textOnly = normalizeGrokCatalogModel({
      ...model("grok-4"),
      inputModalities: ["text"],
    });
    expect(
      enrichGrokCatalogVisionFromOpenRouter(
        [textOnly],
        [
          {
            ...textOnly,
            nativeModelId: "x-ai/grok-4",
            canonicalModelId: "x-ai/grok-4",
            inputModalities: ["text", "image"],
            supportsVision: true,
            metadataSource: "openrouter",
          },
        ],
      ),
    ).toEqual([
      expect.objectContaining({
        inputModalities: ["text", "image"],
        supportsVision: true,
      }),
    ]);
  });

  it("deduplicates models while retaining per-account availability", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    const commands: unknown[] = [];
    const commandWorkers: string[] = [];
    const bridge = {
      attach() {},
      close() {},
      isConnected: () => true,
      request: async (workerId, command) => {
        commandWorkers.push(workerId);
        commands.push(command);
        return {
          models: [
            {
              ...model("grok-4", true),
              inputModalities: ["text"],
            },
            model("grok-code-fast-1"),
          ],
          observedAt: "2026-08-15T12:00:00.000Z",
          weeklyUsage: { usedPercent: 45, resetsAt: 1_787_000_000 },
        };
      },
      sendSurfaceFrame: () => false,
      subscribeSurfaceFrames: () => () => undefined,
      subscribeWorkerDisconnect: () => () => undefined,
    } satisfies WorkerCommandBus;
    const fetchImplementation = (async () =>
      Response.json({
        data: [
          {
            id: "x-ai/grok-4",
            architecture: {
              input_modalities: ["text", "image"],
              output_modalities: ["text"],
            },
            supported_parameters: ["tools"],
          },
        ],
      })) as typeof fetch;
    try {
      await migrate(database, { migrationsFolder });
      const repository = new ServerRepository(
        database,
        new SecretVault({
          activeKeyId: "test",
          keys: [{ id: "test", key: Buffer.alloc(32, 12) }],
        }),
      );
      await repository.ensureLocalIdentity();
      await repository.ensureDefaultModelConfiguration(
        LOCAL_USER_ID,
        "gemma4:12b",
        "http://127.0.0.1:11434/v1",
      );
      await client.exec(`
        INSERT INTO workers (
          id, owner_id, name, platform, architecture, started_at, last_seen_at
        ) VALUES (
          'worker-1', '${LOCAL_USER_ID}', 'Local Worker', 'darwin', 'arm64',
          now(), now()
        ), (
          'worker-2', '${LOCAL_USER_ID}', 'Fresh Worker', 'win32', 'x64',
          now(), now()
        );
      `);
      const provider = await repository.createModelProvider(LOCAL_USER_ID, {
        name: "Grok",
        kind: "grok",
        baseUrl: "https://cli-chat-proxy.grok.com/v1",
      });
      const first = (await repository.listModelProviderAccounts(
        LOCAL_USER_ID,
        provider.id,
      ))![0]!;
      const second = await repository.createModelProviderAccount(
        LOCAL_USER_ID,
        provider.id,
        { label: "Backup Grok" },
      );
      for (const account of [first, second!]) {
        await repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          account.id,
          {
            subjectBlindIndex: "A".repeat(43),
            protectedCredential: {
              formatVersion: 1,
              keyRevision: 1,
              envelope: {
                version: 1,
                algorithm: "AES-256-GCM",
                keyRevision: 1,
                nonce: "AAAAAAAAAAAAAAAA",
                ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
              },
            },
          },
          {
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          },
        );
        await repository.recordModelProviderAccountStatus(
          account.id,
          "worker-1",
          {
            authenticated: true,
            email: `${account.id}@example.com`,
            planType: "SuperGrok",
            weeklyUsage: null,
          },
        );
      }

      const service = new GrokCatalogService(repository, bridge, {
        fetch: fetchImplementation,
      });
      const catalog = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      expect(catalog?.models).toHaveLength(2);
      expect(
        catalog?.models.find(({ nativeModelId }) => nativeModelId === "grok-4"),
      ).toMatchObject({
        inputModalities: ["text", "image"],
        supportsVision: true,
      });
      expect(catalog?.availability).toHaveLength(4);
      expect(
        catalog?.availability.every(({ workerId }) => workerId === null),
      ).toBe(true);
      expect(
        catalog?.syncStates.every(({ workerId }) => workerId === null),
      ).toBe(true);
      expect(
        new Set(
          catalog?.availability.map(({ providerAccountId }) =>
            String(providerAccountId),
          ),
        ),
      ).toEqual(new Set([first.id, second!.id]));
      expect(
        (
          await repository.listModelProviderAccounts(LOCAL_USER_ID, provider.id)
        )?.map(({ weeklyUsageUsedPercent }) => weeklyUsageUsedPercent),
      ).toEqual([45, 45]);
      expect(commands).toHaveLength(2);
      expect(commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "model.grok.catalog",
            provider: expect.objectContaining({
              kind: "grok",
              accountId: first.id,
              credentialHomeKey: provider.id,
            }),
          }),
          expect.objectContaining({
            type: "model.grok.catalog",
            provider: expect.objectContaining({
              kind: "grok",
              accountId: second!.id,
              credentialHomeKey: second!.id,
            }),
          }),
        ]),
      );
      const profiles = await client.query<{ name: string }>(`
        SELECT name FROM model_profiles WHERE discovery_managed = true
        ORDER BY name
      `);
      expect(profiles.rows).toEqual([
        { name: "grok-4" },
        { name: "grok-code-fast-1" },
      ]);
      await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-2",
        true,
        first.id,
      );
      expect(commandWorkers.at(-1)).toBe("worker-2");
      expect(commands.at(-1)).toMatchObject({
        type: "model.grok.catalog",
        provider: { accountId: first.id },
      });
    } finally {
      await client.close();
    }
  });
});
