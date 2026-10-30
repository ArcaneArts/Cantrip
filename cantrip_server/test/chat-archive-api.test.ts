import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  archivedChatWireListSchema,
  conversationCatalogWirePageSchema,
  chatWireListSchema,
  chatWireSummarySchema,
  unprobedCodexRuntimeReport,
} from "@cantrip/protocol";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { buildApp } from "../src/app.js";
import type { ServerConfig } from "../src/config.js";
import { connectDatabase, type DatabaseConnection } from "../src/db/index.js";
import {
  ARCHIVED_CHAT_RETENTION_MS,
  LOCAL_USER_ID,
} from "../src/db/repository.js";
import type { WorkerCommandBus } from "../src/workers/bridge.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

import { settingsEnvelope } from "./native-settings-repository-fixture.js";

const dataDirectory = await mkdtemp(
  path.join(tmpdir(), "cantrip-chat-archive-api-"),
);
const config: ServerConfig = {
  agentModel: "gemma4:26b",
  agentModelProvider: "ollama",
  appOrigins: ["http://127.0.0.1:5173"],
  authMode: "none",
  bootstrapMode: "pnpm-dev",
  dataDirectory,
  deploymentMode: "local",
  host: "127.0.0.1",
  ollamaBaseUrl: "http://127.0.0.1:11434/v1",
  port: 4310,
  workerToken: "test-worker-token",
};
const workerBridge: WorkerCommandBus = {
  attach() {},
  close() {},
  isConnected(workerId) {
    return workerId === "archive-worker";
  },
  sendSurfaceFrame() {
    return false;
  },
  subscribeWorkerDisconnect() {
    return () => undefined;
  },
  subscribeSurfaceFrames() {
    return () => undefined;
  },
  async request(_workerId, command) {
    if (command.type === "chat.messages.reprotect") {
      return command.messages.map(({ source, id, idempotencyKey }) => ({
        id,
        classification: {
          role: source.role,
          mode: source.mode,
          attachmentIds: source.attachmentIds,
        },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: settingsEnvelope,
        },
        reasoningEffort: source.reasoningEffort,
        idempotencyKey,
      }));
    }
    throw new Error(`Unexpected worker command ${command.type}.`);
  },
};

let app: Awaited<ReturnType<typeof buildApp>>;
let database: DatabaseConnection;
let projectId: string;

async function createChat(_title: string) {
  const chat = await database.repository.createChat(LOCAL_USER_ID, projectId, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  if (!chat) throw new Error("Could not create archive test chat.");
  return chat;
}

beforeAll(async () => {
  database = await connectDatabase(config);
  await database.repository.recordWorker(LOCAL_USER_ID, {
    workerId: "archive-worker",
    name: "Archive Worker",
    platform: "darwin",
    architecture: "arm64",
    codexVersion: "0.149.0",
    codexRuntime: unprobedCodexRuntimeReport,
    remoteSurfaces: {
      browser: false,
      transports: ["websocket"],
      maxSessions: 1,
    },
    startedAt: new Date().toISOString(),
  });
  const project = await database.repository.createGithubProject(LOCAL_USER_ID, {
    workerId: "archive-worker",
    ...protectedProjectFields(),
    repositoryBlindIndex: "archive-repository",
    repositoryId: "archive-repository",
    nameWithOwner: "ArcaneArts/Cantrip",
    url: "https://github.com/ArcaneArts/Cantrip",
  });
  projectId = project.id;
  await database.repository.completeGithubProjectSetup(
    LOCAL_USER_ID,
    projectId,
    "archive-worker",
    {
      path: path.join(dataDirectory, "repository"),
      displayPath: "ArcaneArts/Cantrip",
      reused: false,
      updated: false,
      warning: null,
    },
  );
  app = await buildApp({ config, database, logger: false, workerBridge });
  await app.ready();
}, 30_000);

afterAll(async () => {
  await app?.close();
  await rm(dataDirectory, { recursive: true, force: true });
});

describe.sequential("chat archive API", () => {
  it("routes opaque rename and fork labels without synthesizing plaintext", async () => {
    const source = await createChat("Source title");
    const renamed = protectedChatFields(source.id).titleProtection;
    const renameResponse = await app.inject({
      method: "PATCH",
      url: `/api/chats/${source.id}`,
      payload: { titleProtection: renamed },
    });
    expect(renameResponse.statusCode).toBe(200);
    expect(chatWireSummarySchema.parse(renameResponse.json())).toMatchObject({
      id: source.id,
      titleProtection: renamed,
    });

    await database.repository.appendEncryptedMessage(LOCAL_USER_ID, source.id, {
      id: randomUUID(),
      classification: { role: "user", mode: "default", attachmentIds: [] },
      protectedContent: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: settingsEnvelope,
      },
      reasoningEffort: null,
      idempotencyKey: "opaque-title-fork-source",
    });
    const forkFields = protectedChatFields();
    const forkResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${source.id}/fork`,
      payload: forkFields,
    });
    expect(forkResponse.statusCode, forkResponse.body).toBe(201);
    expect(chatWireSummarySchema.parse(forkResponse.json())).toMatchObject({
      id: forkFields.id,
      titleProtection: forkFields.titleProtection,
    });
  });

  it("forks a sidebar conversation without legacy placement", async () => {
    const source = await createChat("Sidebar fork source");
    const fields = protectedChatFields();
    const response = await app.inject({
      method: "POST",
      url: `/api/chats/${source.id}/fork`,
      payload: { ...fields, attachToTabLayout: false },
    });
    expect(response.statusCode, response.body).toBe(201);
    expect(chatWireSummarySchema.parse(response.json()).id).toBe(fields.id);
    const layout = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/panes`,
    });
    expect(layout.statusCode).toBe(200);
    expect(layout.body).not.toContain(fields.id);
    const catalog = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/conversations?state=active&limit=100`,
    });
    expect(
      conversationCatalogWirePageSchema
        .parse(catalog.json())
        .items.some((chat) => chat.id === fields.id),
    ).toBe(true);
  });

  it("rejects a source changed during worker reprotection without creating a fork", async () => {
    const source = await createChat("Concurrent fork");
    await database.repository.appendEncryptedMessage(LOCAL_USER_ID, source.id, {
      id: randomUUID(),
      classification: { role: "user", mode: "default", attachmentIds: [] },
      protectedContent: {
        formatVersion: 1,
        keyRevision: 1,
        envelope: settingsEnvelope,
      },
      reasoningEffort: null,
      idempotencyKey: "concurrent-fork-source",
    });
    const input = protectedChatFields();
    const original = workerBridge.request.bind(workerBridge);
    const request = vi
      .spyOn(workerBridge, "request")
      .mockImplementationOnce(async (...args) => {
        expect(args[1].type).toBe("chat.messages.reprotect");
        // A worker-side callback can read/write through a separate database request.
        // Holding the fork transaction here would deadlock the local database.
        await database.repository.updateChat(LOCAL_USER_ID, source.id, {
          titleProtection: protectedChatFields().titleProtection,
        });
        return original(...args);
      });
    try {
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${source.id}/fork`,
        payload: input,
      });
      expect(response.statusCode, response.body).toBe(409);
      expect(response.json().error).toContain(
        "changed while preparing the fork",
      );
      expect(
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          input.id,
        ),
      ).toBeNull();
      expect(
        await database.repository.listEncryptedMessages(
          LOCAL_USER_ID,
          source.id,
        ),
      ).toHaveLength(1);
    } finally {
      request.mockRestore();
    }
  });

  it("archives populated chats and restores them with their history", async () => {
    const chat = await createChat("Keep this work");
    await database.repository.appendMessage(LOCAL_USER_ID, chat.id, {
      role: "user",
      content: [{ type: "text", text: "Important conversation" }],
      idempotencyKey: "archive-message",
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/chats/${chat.id}`,
    });
    expect(removed.statusCode).toBe(204);
    expect(
      chatWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/chats`,
          })
        ).json(),
      ),
    ).not.toContainEqual(expect.objectContaining({ id: chat.id }));

    const archived = archivedChatWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/archived-chats`,
        })
      ).json(),
    );
    expect(archived).toHaveLength(1);
    expect(archived[0]).toMatchObject({
      id: chat.id,
      messageCount: 1,
      titleProtection: chat.titleProtection,
    });
    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).toBeNull();

    const restoredResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/restore`,
    });
    expect(restoredResponse.statusCode).toBe(200);
    expect(chatWireSummarySchema.parse(restoredResponse.json()).id).toBe(
      chat.id,
    );
    expect(
      await database.repository.listMessages(LOCAL_USER_ID, chat.id),
    ).toHaveLength(1);
  });

  it("hard-deletes empty chats and blocks removal during active work", async () => {
    const empty = await createChat("Empty agent");
    expect(
      (await app.inject({ method: "DELETE", url: `/api/chats/${empty.id}` }))
        .statusCode,
    ).toBe(204);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${empty.id}/restore`,
        })
      ).statusCode,
    ).toBe(404);

    const running = await createChat("Busy agent");
    await database.repository.setChatStatus(running.id, "running");
    const blocked = await app.inject({
      method: "DELETE",
      url: `/api/chats/${running.id}`,
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toEqual({ error: "Stop the running chat first." });
    await database.repository.setChatStatus(running.id, "idle");
  });

  it("reconciles concurrent resource creation retries to one Agent", async () => {
    const fields = protectedChatFields();
    const responses = await Promise.all(
      Array.from({ length: 3 }, () =>
        app.inject({
          method: "POST",
          url: `/api/projects/${projectId}/chats`,
          payload: { ...fields, attachToTabLayout: false },
        }),
      ),
    );
    for (const response of responses) {
      expect(response.statusCode, response.body).toBe(201);
      expect(chatWireSummarySchema.parse(response.json()).id).toBe(fields.id);
    }
    const catalog = await database.repository.conversations.list(
      LOCAL_USER_ID,
      projectId,
      { state: "active", limit: 100 },
    );
    expect(catalog?.items.filter(({ id }) => id === fields.id)).toHaveLength(1);
  });

  it("explicitly archives an empty Agent and restores it without a tab", async () => {
    const fields = protectedChatFields();
    const response = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: { ...fields, attachToTabLayout: false },
    });
    expect(response.statusCode, response.body).toBe(201);
    const chat = chatWireSummarySchema.parse(response.json());
    const retried = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: { ...fields, attachToTabLayout: false },
    });
    expect(retried.statusCode, retried.body).toBe(201);
    expect(chatWireSummarySchema.parse(retried.json()).id).toBe(chat.id);
    const conflicting = await app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/chats`,
      payload: {
        ...fields,
        titleProtection: protectedChatFields().titleProtection,
        attachToTabLayout: false,
      },
    });
    expect(conflicting.statusCode, conflicting.body).toBe(409);
    const layout = async () => {
      const response = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/panes`,
      });
      expect(response.statusCode, response.body).toBe(200);
      return response.body;
    };
    expect(await layout()).not.toContain(chat.id);
    const draft = {
      protectedContent: {
        formatVersion: 1 as const,
        keyRevision: 1,
        envelope: settingsEnvelope,
      },
    };
    await database.repository.updateChatComposerDraft(
      LOCAL_USER_ID,
      chat.id,
      draft,
    );
    const archive = () =>
      app.inject({ method: "POST", url: `/api/chats/${chat.id}/archive` });
    expect((await archive()).statusCode).toBe(204);
    const readArchive = () =>
      database.repository.listArchivedChats(LOCAL_USER_ID, projectId);
    const original = (await readArchive()).find(({ id }) => id === chat.id);
    expect(original).toMatchObject({
      id: chat.id,
      messageCount: 0,
      titleProtection: fields.titleProtection,
    });
    expect((await archive()).statusCode).toBe(204);
    expect((await readArchive()).find(({ id }) => id === chat.id)).toEqual(
      original,
    );
    const restored = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/restore`,
      payload: { attachToTabLayout: false },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect(chatWireSummarySchema.parse(restored.json())).toMatchObject({
      id: chat.id,
      automationPaused: true,
    });
    expect(await layout()).not.toContain(chat.id);
    // A stale permanent-delete action must not remove a restored active chat.
    const draftResponse = await app.inject({
      method: "GET",
      url: `/api/chats/${chat.id}/composer-draft`,
    });
    expect(draftResponse.statusCode, draftResponse.body).toBe(200);
    expect(draftResponse.json().state).toEqual(draft);
    const repeatRestore = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/restore`,
      payload: { attachToTabLayout: false },
    });
    expect(repeatRestore.statusCode, repeatRestore.body).toBe(200);
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${chat.id}/permanent`,
        })
      ).statusCode,
    ).toBe(404);
    expect(
      await database.repository.getChatExecutionContext(LOCAL_USER_ID, chat.id),
    ).not.toBeNull();
  });

  it("rejects foreign and executing Agent archive requests", async () => {
    const chat = await createChat("Protected archive");
    expect(
      await database.repository.archiveAgentConversation(
        "other-owner",
        chat.id,
      ),
    ).toBe(false);
    for (const status of ["running", "waiting-for-approval"] as const) {
      await database.repository.setChatStatus(chat.id, status);
      const response = await app.inject({
        method: "POST",
        url: `/api/chats/${chat.id}/archive`,
      });
      expect(response.statusCode).toBe(409);
      expect(
        await database.repository.getChatExecutionContext(
          LOCAL_USER_ID,
          chat.id,
        ),
      ).not.toBeNull();
    }
    await database.repository.setChatStatus(chat.id, "idle");
  });

  it("pages the complete recent Agent catalog and ignores stale usage retries", async () => {
    const first = await createChat("First conversation");
    const second = await createChat("Second conversation");
    const clientId = randomUUID();
    const operation = { clientId, operationId: randomUUID(), sequence: 2 };
    const use = (id: string, payload: typeof operation) =>
      app.inject({ method: "POST", url: `/api/chats/${id}/usage`, payload });
    const used = await use(first.id, operation);
    expect(used.statusCode, used.body).toBe(200);
    const replay = await use(first.id, operation);
    expect(replay.json()).toEqual(used.json());
    const stale = await use(second.id, {
      ...operation,
      operationId: randomUUID(),
      sequence: 1,
    });
    expect(stale.json()).toMatchObject({ applied: false });
    expect((await use(second.id, operation)).statusCode).toBe(409);
    expect(
      await database.repository.conversations.recordUsage(
        "foreign-owner",
        first.id,
        operation,
      ),
    ).toBeNull();
    // Ordinary status/title writes must not manufacture last usage.
    await database.repository.setChatStatus(second.id, "running");
    await database.repository.setChatStatus(second.id, "idle");
    const page = async (cursor?: string) => {
      const result = await app.inject({
        method: "GET",
        url: `/api/projects/${projectId}/conversations?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      });
      expect(result.statusCode, result.body).toBe(200);
      return conversationCatalogWirePageSchema.parse(result.json());
    };
    let current = await page();
    expect(current.items[0]?.id).toBe(first.id);
    const total = current.total;
    const ids = current.items.map(({ id }) => id);
    const firstCursor = current.nextCursor;
    while (current.nextCursor) {
      current = await page(current.nextCursor);
      ids.push(...current.items.map(({ id }) => id));
    }
    expect(new Set(ids).size).toBe(total);
    expect(ids).toHaveLength(total);
    expect(ids).toContain(second.id);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/conversations?state=archived&cursor=${firstCursor}`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/conversations?cursor=invalid`,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      await database.repository.conversations.list("foreign-owner", projectId, {
        state: "active",
        limit: 2,
      }),
    ).toBeNull();
    await app.inject({ method: "POST", url: `/api/chats/${first.id}/archive` });
    const archived = await app.inject({
      method: "GET",
      url: `/api/projects/${projectId}/conversations?state=archived`,
    });
    expect(archived.statusCode, archived.body).toBe(200);
    expect(
      conversationCatalogWirePageSchema.parse(archived.json()).items,
    ).toContainEqual(
      expect.objectContaining({ id: first.id, messageCount: 0 }),
    );
    expect(
      (
        await use(first.id, {
          ...operation,
          operationId: randomUUID(),
          sequence: 3,
        })
      ).statusCode,
    ).toBe(404);
    const restored = await app.inject({
      method: "POST",
      url: `/api/chats/${first.id}/restore`,
      payload: { attachToTabLayout: false },
    });
    expect(restored.statusCode, restored.body).toBe(200);
    expect((await page()).items[0]?.id).toBe(first.id);
  });

  it("persists completed turns until one client acknowledges them", async () => {
    const chat = await createChat("Unread completion");
    expect(chat.hasUnreadCompletion).toBe(false);

    await database.repository.setChatStatus(chat.id, "running");
    await database.repository.setChatStatus(chat.id, "idle");
    const completed = chatWireListSchema.parse(
      (
        await app.inject({
          method: "GET",
          url: `/api/projects/${projectId}/chats`,
        })
      ).json(),
    );
    expect(completed.find(({ id }) => id === chat.id)).toMatchObject({
      hasUnreadCompletion: true,
      status: "idle",
    });

    const acknowledgedResponse = await app.inject({
      method: "POST",
      url: `/api/chats/${chat.id}/completion/read`,
      payload: {},
    });
    expect(acknowledgedResponse.statusCode).toBe(200);
    expect(
      chatWireSummarySchema.parse(acknowledgedResponse.json()),
    ).toMatchObject({
      hasUnreadCompletion: false,
      id: chat.id,
    });
  });

  it("keeps Task conversations out of both Agent catalogs and explicit archive", async () => {
    const fields = protectedChatFields();
    const created = await database.repository.createTask(
      LOCAL_USER_ID,
      projectId,
      {
        chatId: fields.id,
        titleProtection: fields.titleProtection,
        worktreeMode: "agent-managed",
        planGoalEnabled: false,
        priority: 0,
        requestedTaskWorkerId: null,
        task: {
          classification: {
            state: "draft",
            stableStateBeforeFailure: null,
            activeOperationKind: null,
            planAuthorship: "agent",
            planningRound: 0,
            hasPlan: false,
            hasQuestions: false,
            hasFinalPlan: false,
            hasGoalPrompt: false,
            lastError: null,
          },
          protectedContent: {
            formatVersion: 1,
            keyRevision: 1,
            envelope: settingsEnvelope,
          },
        },
      },
    );
    expect(created).not.toBeNull();
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${fields.id}/archive`,
        })
      ).statusCode,
    ).toBe(404);
    const active = await database.repository.conversations.list(
      LOCAL_USER_ID,
      projectId,
      { state: "active", limit: 100 },
    );
    expect(active?.items.map(({ id }) => id)).not.toContain(fields.id);
    const message = await database.repository.appendTaskMessage(
      LOCAL_USER_ID,
      fields.id,
      {
        id: randomUUID(),
        classification: { role: "user", mode: "default", attachmentIds: [] },
        protectedContent: {
          formatVersion: 1,
          keyRevision: 1,
          envelope: settingsEnvelope,
        },
        reasoningEffort: null,
        idempotencyKey: "catalog-task-message",
      },
    );
    expect(message).not.toBeNull();
    expect(await database.repository.deleteChat(LOCAL_USER_ID, fields.id)).toBe(
      "archived",
    );
    const archived = await database.repository.conversations.list(
      LOCAL_USER_ID,
      projectId,
      { state: "archived", limit: 100 },
    );
    expect(archived?.items.map(({ id }) => id)).not.toContain(fields.id);
    expect(
      await database.repository.listArchivedChats(LOCAL_USER_ID, projectId),
    ).toContainEqual(
      expect.objectContaining({ id: fields.id, experience: "task" }),
    );
  });

  it("permanently removes archived chats after explicit deletion or expiry", async () => {
    const explicit = await createChat("Delete forever");
    await database.repository.appendMessage(LOCAL_USER_ID, explicit.id, {
      role: "user",
      content: [{ type: "text", text: "Disposable" }],
      idempotencyKey: "archive-explicit",
    });
    await app.inject({ method: "DELETE", url: `/api/chats/${explicit.id}` });
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: `/api/chats/${explicit.id}/permanent`,
        })
      ).statusCode,
    ).toBe(204);

    const expired = await createChat("Expired agent");
    await database.repository.appendMessage(LOCAL_USER_ID, expired.id, {
      role: "user",
      content: [{ type: "text", text: "Old work" }],
      idempotencyKey: "archive-expired",
    });
    await app.inject({ method: "DELETE", url: `/api/chats/${expired.id}` });
    expect(
      await database.repository.purgeExpiredArchivedChats(
        LOCAL_USER_ID,
        new Date(Date.now() + ARCHIVED_CHAT_RETENTION_MS + 1),
      ),
    ).toBeGreaterThanOrEqual(1);
    expect(
      archivedChatWireListSchema.parse(
        (
          await app.inject({
            method: "GET",
            url: `/api/projects/${projectId}/archived-chats`,
          })
        ).json(),
      ),
    ).toHaveLength(0);
  });
});
