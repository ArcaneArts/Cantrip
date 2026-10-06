import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";
import { LOCAL_USER_ID, ServerRepository } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { SecretVault } from "../src/security/secret-vault.js";
import { protectedChatFields } from "./private-label-fixture.js";
import {
  automaticNamingEnabled,
  generateAutomaticTitle,
} from "../src/chats/automatic-labeling.js";

describe("automatic naming eligibility", () => {
  it("gives random names precedence without disabling tasks", () => {
    const settings = {
      autoNameTasks: true,
      autoNameChats: true,
      randomAgentNames: true,
    };
    expect(automaticNamingEnabled(settings, "agent")).toBe(false);
    expect(automaticNamingEnabled(settings, "chat")).toBe(false);
    expect(automaticNamingEnabled(settings, "task")).toBe(true);
    expect(
      automaticNamingEnabled({ ...settings, randomAgentNames: false }, "agent"),
    ).toBe(true);
    expect(
      automaticNamingEnabled({ ...settings, autoNameTasks: false }, "task"),
    ).toBe(false);
  });
  it("migrates defaults and fences concurrent jobs and manual renames", async () => {
    const client = new PGlite();
    const database = drizzle(client, { schema });
    await migrate(database, {
      migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
    });
    const repository = new ServerRepository(
      database,
      new SecretVault({
        activeKeyId: "test",
        keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
      }),
    );
    try {
      await repository.ensureLocalIdentity();
      await repository.ensureAccountConfiguration(LOCAL_USER_ID);
      const workerId = randomUUID();
      await database.insert(schema.workers).values({
        id: workerId,
        ownerId: LOCAL_USER_ID,
        name: "Fixture",
        platform: "darwin",
        architecture: "arm64",
        startedAt: new Date(),
        lastSeenAt: new Date(),
      });
      expect(await repository.getUserSettings(LOCAL_USER_ID)).toMatchObject({
        autoNameTasks: true,
        autoNameChats: true,
        labelingModelId: null,
      });
      await repository.updateSettings(LOCAL_USER_ID, {
        autoNameTasks: false,
        randomAgentNames: true,
      });
      expect(await repository.getUserSettings(LOCAL_USER_ID)).toMatchObject({
        autoNameTasks: false,
        autoNameChats: true,
        randomAgentNames: true,
      });
      const first = protectedChatFields();
      const explicit = protectedChatFields();
      const insertChat = async (
        fields: ReturnType<typeof protectedChatFields>,
        autoTitlePending = false,
      ) => {
        const rootId = randomUUID();
        await database.transaction(async (transaction) => {
          await transaction.insert(schema.chats).values({
            id: fields.id,
            ownerId: LOCAL_USER_ID,
            contextKind: "standalone",
            activeWorkerId: workerId,
            activeScratchRootId: rootId,
            worktreeMode: null,
            protectedLabel: fields.titleProtection,
            autoTitlePending,
          });
          await transaction.insert(schema.standaloneChatRoots).values({
            id: rootId,
            ownerId: LOCAL_USER_ID,
            chatId: fields.id,
            workerId,
            status: "provisioning",
          });
        });
      };
      await insertChat(first, true);
      await insertChat(explicit);
      expect(
        await repository.chatState.claimAutomaticTitle(
          LOCAL_USER_ID,
          explicit.id,
        ),
      ).toBeNull();
      const [a, b] = await Promise.all([
        repository.chatState.claimAutomaticTitle(LOCAL_USER_ID, first.id),
        repository.chatState.claimAutomaticTitle(LOCAL_USER_ID, first.id),
      ]);
      expect([a, b].filter(Boolean)).toHaveLength(1);
      const claim = (a ?? b)!;
      expect(
        await repository.chatState.finishAutomaticTitle(
          "not-owner",
          first.id,
          claim.claimId,
          first.titleProtection,
        ),
      ).toBeNull();
      await repository.chatState.finishAutomaticTitle(
        LOCAL_USER_ID,
        first.id,
        claim.claimId,
        null,
        true,
      );
      const retry = (await repository.chatState.claimAutomaticTitle(
        LOCAL_USER_ID,
        first.id,
      ))!;
      expect(retry.claimId).not.toBe(claim.claimId);
      const manual = protectedChatFields(first.id).titleProtection;
      await repository.updateChat(LOCAL_USER_ID, first.id, {
        titleProtection: manual,
      });
      expect(
        await repository.chatState.finishAutomaticTitle(
          LOCAL_USER_ID,
          first.id,
          retry.claimId,
          first.titleProtection,
        ),
      ).toBeNull();
      expect(
        await repository.chatState.claimAutomaticTitle(LOCAL_USER_ID, first.id),
      ).toBeNull();
      expect(
        (await database.select().from(schema.chats)).find(
          ({ id }) => id === first.id,
        )?.protectedLabel,
      ).toEqual(manual);
      const generated = protectedChatFields();
      await insertChat(generated, true);
      const finalClaim = (await repository.chatState.claimAutomaticTitle(
        LOCAL_USER_ID,
        generated.id,
        randomUUID(),
      ))!;
      expect(
        await repository.chatState.finishAutomaticTitle(
          LOCAL_USER_ID,
          generated.id,
          finalClaim.claimId,
          generated.titleProtection,
        ),
      ).not.toBeNull();
      expect(
        await repository.chatState.claimAutomaticTitle(
          LOCAL_USER_ID,
          generated.id,
        ),
      ).toBeNull();
    } finally {
      await client.close();
    }
  }, 30_000);
});

describe("background title orchestration", () => {
  function fixture() {
    const titleProtection = protectedChatFields().titleProtection;
    const preferences = {
      autoNameTasks: true,
      autoNameChats: true,
      randomAgentNames: false,
      labelingModelId: null as string | null,
      defaultModelId: "default",
      defaultReasoningEffort: "high",
    };
    const context = {
      workerId: "worker",
      contextKind: "standalone",
      experience: "agent",
    };
    const claim = vi.fn().mockResolvedValue({ claimId: "claim" });
    const finish = vi.fn().mockResolvedValue({ projectId: null });
    const request = vi
      .fn()
      .mockResolvedValue({ titleProtection, emptyInput: false });
    const routes = vi.fn().mockResolvedValue([
      {
        model: {
          name: "test-model",
          reasoningEffort: "high",
          catalog: {
            supportedReasoningEfforts: [{ effort: "high" }, { effort: "low" }],
            defaultReasoningEffort: "medium",
          },
        },
        provider: {},
      },
    ]);
    const latestTask = vi.fn().mockResolvedValue(null);
    const publish = vi.fn();
    const options = {
      ownerId: "owner",
      chatId: "chat",
      input: { kind: "message", message: { id: "first" } },
      repository: {
        getChatExecutionContext: vi.fn().mockResolvedValue(context),
        getUserSettings: vi
          .fn()
          .mockImplementation(async () => ({ ...preferences })),
        chatState: { claimAutomaticTitle: claim, finishAutomaticTitle: finish },
        tasks: { get: latestTask },
      },
      bridge: { request },
      availableModelRuntimes: routes,
      publishChatSummary: publish,
    } as unknown as Parameters<typeof generateAutomaticTitle>[0];
    return {
      options,
      preferences,
      context,
      claim,
      finish,
      request,
      routes,
      publish,
      titleProtection,
      latestTask,
    };
  }
  it("uses the default model, minimum known effort and only the initial encrypted input", async () => {
    const f = fixture();
    await generateAutomaticTitle(f.options);
    expect(f.routes).toHaveBeenCalledExactlyOnceWith(f.context, "default");
    expect(f.request).toHaveBeenCalledExactlyOnceWith(
      "worker",
      expect.objectContaining({
        type: "label.generate",
        labelKind: "chat",
        input: f.options.input,
        model: expect.objectContaining({
          name: "test-model",
          reasoningEffort: "low",
        }),
      }),
      { timeoutMs: 30_000 },
    );
    expect(f.claim).toHaveBeenCalledExactlyOnceWith("owner", "chat", "first");
    expect(f.publish).toHaveBeenCalledExactlyOnceWith("chat", null);
  });
  it("uses a configured label model and preserves its default when efforts are unknown", async () => {
    const f = fixture();
    f.preferences.labelingModelId = "label-model";
    f.routes.mockResolvedValue([
      {
        model: {
          name: "custom",
          catalog: {
            supportedReasoningEfforts: [],
            defaultReasoningEffort: "medium",
          },
        },
        provider: {},
      },
    ]);
    await generateAutomaticTitle(f.options);
    expect(f.routes).toHaveBeenCalledWith(f.context, "label-model");
    expect(f.request.mock.calls[0]?.[1].model.reasoningEffort).toBe("medium");
  });
  it("soft-disables chat naming for random names but still names tasks", async () => {
    const f = fixture();
    f.preferences.randomAgentNames = true;
    await generateAutomaticTitle(f.options);
    expect(f.claim).not.toHaveBeenCalled();
    expect(f.request).not.toHaveBeenCalled();
    f.options.input = {
      kind: "task",
      task: { rowVersion: 1 },
    } as typeof f.options.input;
    await generateAutomaticTitle(f.options);
    expect(f.request.mock.calls[0]?.[1].labelKind).toBe("task");
  });
  it("does not dispatch for an explicit, already claimed, or manually renamed title", async () => {
    const f = fixture();
    f.claim.mockResolvedValue(null);
    await generateAutomaticTitle(f.options);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("discards the result when random naming is enabled during inference", async () => {
    const f = fixture();
    f.request.mockImplementation(async () => {
      f.preferences.randomAgentNames = true;
      return { titleProtection: f.titleProtection };
    });
    await generateAutomaticTitle(f.options);
    expect(f.finish).toHaveBeenCalledWith(
      "owner",
      "chat",
      "claim",
      null,
      false,
    );
    expect(f.publish).not.toHaveBeenCalled();
  });
  it("swallows provider failure, clears the claim and never retries or publishes", async () => {
    const f = fixture();
    f.request.mockRejectedValue(new Error("synthetic unavailable provider"));
    await expect(generateAutomaticTitle(f.options)).resolves.toBeUndefined();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.finish).toHaveBeenCalledWith("owner", "chat", "claim", null);
    expect(f.publish).not.toHaveBeenCalled();
  });
  it.each(["queued", "started"])(
    "reconciles a first submission that raced empty task creation without polling (%s)",
    async (state) => {
      const f = fixture();
      f.options.input = {
        kind: "task",
        task: { rowVersion: 1 },
      } as typeof f.options.input;
      f.latestTask.mockResolvedValue({
        rowVersion: 2,
        dispatch: { state },
      });
      f.request.mockResolvedValueOnce({
        titleProtection: null,
        emptyInput: true,
      });
      await generateAutomaticTitle(f.options);
      expect(f.latestTask).toHaveBeenCalledTimes(1);
      expect(f.request).toHaveBeenCalledTimes(2);
      expect(f.request.mock.calls[1]?.[1].input).toEqual({
        kind: "task",
        task: { rowVersion: 2, dispatch: { state } },
      });
      expect(f.publish).toHaveBeenCalledTimes(1);
    },
  );
  it("does not label an autosaved partial draft", async () => {
    const f = fixture();
    f.options.input = {
      kind: "task",
      task: { rowVersion: 1 },
    } as typeof f.options.input;
    f.latestTask.mockResolvedValue({ rowVersion: 2, dispatch: null });
    f.request.mockResolvedValue({ titleProtection: null, emptyInput: true });
    await generateAutomaticTitle(f.options);
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.publish).not.toHaveBeenCalled();
  });
});
