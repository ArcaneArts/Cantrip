import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it } from "vitest";

import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  ChatGptCatalogService,
  normalizeChatGptModel,
} from "../src/models/chatgpt-catalog.js";
import { SecretVault } from "../src/security/secret-vault.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

const model = (
  id: string,
  options: { hidden?: boolean; isDefault?: boolean } = {},
) => ({
  id: `picker-${id}`,
  model: id,
  displayName: id === "gpt-5.6-sol" ? "GPT-5.6 Sol" : id,
  description: `${id} from Codex`,
  hidden: options.hidden ?? false,
  isDefault: options.isDefault ?? false,
  inputModalities: ["text", "image"],
  supportedReasoningEfforts: [
    { reasoningEffort: "medium", description: "Balanced reasoning" },
    { reasoningEffort: "high", description: "Deeper reasoning" },
  ],
  defaultReasoningEffort: "medium",
  modelSpecialty: "coding",
  supportsPersonality: true,
  upgrade: null,
  upgradeInfo: null,
  availabilityNux: null,
  additionalSpeedTiers: [],
  serviceTiers: [],
  defaultServiceTier: null,
});

describe("ChatGPT catalog", () => {
  it("normalizes native Codex picker metadata conservatively", () => {
    expect(normalizeChatGptModel(model("gpt-5.6-sol"))).toMatchObject({
      nativeModelId: "gpt-5.6-sol",
      canonicalModelId: "gpt-5.6-sol",
      displayName: "GPT-5.6 Sol",
      inputModalities: ["text", "image"],
      supportsVision: true,
      supportsReasoning: true,
      supportsTools: null,
      supportedReasoningEfforts: [
        { effort: "medium", description: "Balanced reasoning" },
        { effort: "high", description: "Deeper reasoning" },
      ],
      defaultReasoningEffort: "medium",
      metadataSource: "codex",
    });
  });

  it("deduplicates shared models while tracking each signed-in account", async () => {
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
            model("gpt-5.6-sol", { isDefault: true }),
            model("internal-preview", { hidden: true }),
          ],
          observedAt: "2026-08-14T12:00:00.000Z",
          weeklyUsage: { usedPercent: 35, resetsAt: 1_787_000_000 },
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
          keys: [{ id: "test", key: Buffer.alloc(32, 10) }],
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
        name: "ChatGPT",
        kind: "chatgpt",
        baseUrl: "https://chatgpt.com/backend-api/codex/responses",
      });
      const first = (await repository.listModelProviderAccounts(
        LOCAL_USER_ID,
        provider.id,
      ))![0]!;
      const second = await repository.createModelProviderAccount(
        LOCAL_USER_ID,
        provider.id,
        { label: "Backup" },
      );
      for (const account of [first, second!]) {
        await repository.storeModelProviderAccountCredential(
          LOCAL_USER_ID,
          provider.id,
          account.id,
          {
            accessToken: `access-${account.id}`,
            accountId: `upstream-${account.id}`,
            email: `${account.id}@example.com`,
            expiresAt: Date.now() + 3_600_000,
            idToken: `identity-${account.id}`,
            kind: "chatgpt",
            planType: "pro",
            refreshToken: `refresh-${account.id}`,
            userId: `user-${account.id}`,
            version: 1,
          },
        );
        await repository.recordModelProviderAccountStatus(
          account.id,
          "worker-1",
          {
            authenticated: true,
            email: `${account.id}@example.com`,
            planType: "pro",
            weeklyUsage: { usedPercent: 10, resetsAt: null },
          },
        );
      }

      const service = new ChatGptCatalogService(repository, bridge);
      const catalog = await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
      );
      expect(catalog?.models).toHaveLength(2);
      expect(catalog?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            nativeModelId: "gpt-5.6-sol",
            isDefault: true,
            hidden: false,
          }),
          expect.objectContaining({
            nativeModelId: "internal-preview",
            hidden: true,
          }),
        ]),
      );
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
      ).toEqual([35, 35]);

      const profiles = await client.query<{ name: string }>(`
        SELECT name FROM model_profiles WHERE discovery_managed = true
      `);
      expect(profiles.rows).toEqual([{ name: "gpt-5.6-sol" }]);
      expect(
        (await repository.getSettings(LOCAL_USER_ID)).preferences
          .defaultModelId,
      ).not.toBe(`discovered:model:${catalog?.models[0]?.id}`);

      await client.exec(`
        UPDATE user_settings SET default_model_id = NULL
        WHERE user_id = '${LOCAL_USER_ID}'
      `);
      await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-1",
        true,
        first.id,
      );
      const refreshedSettings = await repository.getSettings(LOCAL_USER_ID);
      const selectedDefault = refreshedSettings.models.find(
        ({ id }) => id === refreshedSettings.preferences.defaultModelId,
      );
      expect(selectedDefault?.name).toBe("gpt-5.6-sol");
      expect(commands).toHaveLength(3);
      expect(commands[0]).toMatchObject({
        type: "model.chatgpt.catalog",
        provider: { accountId: first.id, credentialHomeKey: provider.id },
      });
      expect(commands[1]).toMatchObject({
        type: "model.chatgpt.catalog",
        provider: { accountId: second!.id, credentialHomeKey: second!.id },
      });
      await service.getProviderCatalog(
        LOCAL_USER_ID,
        provider.id,
        "worker-2",
        true,
        first.id,
      );
      expect(commandWorkers.at(-1)).toBe("worker-2");
      expect(commands.at(-1)).toMatchObject({
        type: "model.chatgpt.catalog",
        provider: { accountId: first.id },
      });
    } finally {
      await client.close();
    }
  });
});
