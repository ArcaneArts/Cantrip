import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { describe, expect, it, vi } from "vitest";

import {
  LOCAL_USER_ID,
  ServerRepository,
  type ChatLiveRouting,
} from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { TaskLiveInvalidationRouter } from "../src/live/task-live-routing.js";
import { SecretVault } from "../src/security/secret-vault.js";

import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const migrationsFolder = fileURLToPath(new URL("../drizzle", import.meta.url));

async function fixture() {
  const client = new PGlite();
  const queries: string[] = [];
  const database = drizzle(client, {
    schema,
    logger: { logQuery: (query) => queries.push(query) },
  });
  await migrate(database, { migrationsFolder });
  const repository = new ServerRepository(
    database,
    new SecretVault({
      activeKeyId: "test",
      keys: [{ id: "test", key: Buffer.alloc(32, 7) }],
    }),
  );
  await repository.ensureLocalIdentity();

  const workerId = randomUUID();
  const project = protectedProjectFields();
  const sourceId = randomUUID();
  const worktreeId = randomUUID();
  await database.insert(schema.workers).values({
    id: workerId,
    ownerId: LOCAL_USER_ID,
    name: "routing-worker",
    platform: "darwin",
    architecture: "arm64",
    startedAt: new Date(),
    lastSeenAt: new Date(),
  });
  await database.insert(schema.projects).values({
    id: project.id,
    ownerId: LOCAL_USER_ID,
    protectedLabel: project.nameProtection,
    githubRepositoryBlindIndex: randomUUID(),
  });
  await database.insert(schema.projectSources).values({
    id: sourceId,
    projectId: project.id,
    workerId,
    absolutePath: `/fixture/${project.id}`,
    displayPath: `/fixture/${project.id}`,
  });
  await database.insert(schema.projectWorktrees).values({
    id: worktreeId,
    projectSourceId: sourceId,
    workerId,
    name: "main",
    absolutePath: `/fixture/${project.id}`,
    displayPath: `/fixture/${project.id}`,
    isPrimary: true,
    isDefault: true,
    origin: "cantrip",
    lifecycleState: "ready",
  });

  const taskChatId = randomUUID();
  const agentChatId = randomUUID();
  const archivedTaskChatId = randomUUID();
  await database.insert(schema.chats).values([
    {
      id: taskChatId,
      ownerId: LOCAL_USER_ID,
      projectId: project.id,
      activeWorktreeId: worktreeId,
      protectedLabel: protectedChatFields().titleProtection,
      experience: "task",
    },
    {
      id: agentChatId,
      ownerId: LOCAL_USER_ID,
      projectId: project.id,
      activeWorktreeId: worktreeId,
      protectedLabel: protectedChatFields().titleProtection,
      experience: "agent",
    },
    {
      id: archivedTaskChatId,
      ownerId: LOCAL_USER_ID,
      projectId: project.id,
      activeWorktreeId: worktreeId,
      protectedLabel: protectedChatFields().titleProtection,
      experience: "task",
      archivedAt: new Date(),
    },
  ]);
  const standaloneChatId = randomUUID();
  const standaloneRootId = randomUUID();
  await database.transaction(async (transaction) => {
    await transaction.insert(schema.chats).values({
      id: standaloneChatId,
      ownerId: LOCAL_USER_ID,
      contextKind: "standalone",
      projectId: null,
      activeWorkerId: workerId,
      activeScratchRootId: standaloneRootId,
      protectedLabel: protectedChatFields().titleProtection,
      experience: "agent",
      worktreeMode: null,
    });
    await transaction.insert(schema.standaloneChatRoots).values({
      id: standaloneRootId,
      chatId: standaloneChatId,
      ownerId: LOCAL_USER_ID,
      workerId,
      status: "provisioning",
    });
  });
  queries.length = 0;
  return {
    agentChatId,
    archivedTaskChatId,
    client,
    projectId: project.id,
    queries,
    repository,
    standaloneChatId,
    taskChatId,
  };
}

describe("Task live invalidation routing", () => {
  it("uses one narrow SQL query for a 100-invalidation ID-only burst", async () => {
    const value = await fixture();
    try {
      const published: Array<{ entityId: string; projectId: string }> = [];
      const router = new TaskLiveInvalidationRouter(
        (ownerId, chatId) =>
          value.repository.getChatLiveRouting(ownerId, chatId),
        ({ entityId, projectId }) => published.push({ entityId, projectId }),
      );

      await Promise.all(
        Array.from({ length: 100 }, (_, index) =>
          router.route({
            chatId: value.taskChatId,
            entityId: `entity-${index}`,
            ownerId: LOCAL_USER_ID,
            resource: "task",
          }),
        ),
      );

      expect(value.queries).toHaveLength(1);
      expect(value.queries[0]?.toLowerCase()).toContain('from "chats"');
      expect(value.queries[0]?.toLowerCase()).not.toContain(" join ");
      expect(published).toHaveLength(100);
      expect(published[0]).toEqual({
        entityId: "entity-0",
        projectId: value.projectId,
      });
      expect(published.at(-1)).toEqual({
        entityId: "entity-99",
        projectId: value.projectId,
      });

      await router.route({
        chatId: value.taskChatId,
        entityId: "after-burst",
        ownerId: LOCAL_USER_ID,
        resource: "task",
      });
      expect(value.queries).toHaveLength(2);
      expect(published.at(-1)).toEqual({
        entityId: "after-burst",
        projectId: value.projectId,
      });
    } finally {
      await value.client.close();
    }
  });

  it("uses known routing for a Task cycle without issuing routing SQL", async () => {
    const value = await fixture();
    try {
      const events: string[] = [];
      const router = new TaskLiveInvalidationRouter(
        (ownerId, chatId) =>
          value.repository.getChatLiveRouting(ownerId, chatId),
        ({ entityId, resource }) => events.push(`${resource}:${entityId}`),
      );
      const routing: ChatLiveRouting = {
        experience: "task",
        projectId: value.projectId,
      };

      const routes = Promise.all(
        [
          "task",
          "chat-message",
          "chat-plan",
          "chat-goal",
          "agent-interaction",
        ].map((resource) =>
          router.route({
            chatId: value.taskChatId,
            entityId: null,
            ownerId: LOCAL_USER_ID,
            resource: resource as
              | "agent-interaction"
              | "chat-goal"
              | "chat-message"
              | "chat-plan"
              | "task",
            routing,
          }),
        ),
      );

      expect(events).toEqual([]);
      await routes;

      expect(value.queries).toEqual([]);
      expect(events).toEqual([
        `task:${value.taskChatId}`,
        `chat-message:${value.taskChatId}`,
        `chat-plan:${value.taskChatId}`,
        `chat-goal:${value.taskChatId}`,
        `agent-interaction:${value.taskChatId}`,
      ]);
    } finally {
      await value.client.close();
    }
  });

  it("excludes non-Task, archived, unowned, and standalone routing", async () => {
    const value = await fixture();
    try {
      const publish = vi.fn();
      const router = new TaskLiveInvalidationRouter(
        (ownerId, chatId) =>
          value.repository.getChatLiveRouting(ownerId, chatId),
        publish,
      );

      await router.route({
        chatId: value.agentChatId,
        entityId: null,
        ownerId: LOCAL_USER_ID,
        resource: "task",
      });
      await router.route({
        chatId: value.archivedTaskChatId,
        entityId: null,
        ownerId: LOCAL_USER_ID,
        resource: "task",
      });
      await router.route({
        chatId: value.taskChatId,
        entityId: null,
        ownerId: randomUUID(),
        resource: "task",
      });
      await router.route({
        chatId: value.standaloneChatId,
        entityId: null,
        ownerId: LOCAL_USER_ID,
        resource: "task",
      });

      expect(publish).not.toHaveBeenCalled();
      expect(value.queries).toHaveLength(4);
    } finally {
      await value.client.close();
    }
  });

  it("keeps chat-before-project ordering and retries after lookup failure", async () => {
    const events: string[] = [];
    const routing: ChatLiveRouting = {
      experience: "task",
      projectId: "project-one",
    };
    const load = vi
      .fn<
        (ownerId: string, chatId: string) => Promise<ChatLiveRouting | null>
      >()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(routing);
    const router = new TaskLiveInvalidationRouter(load, ({ entityId }) => {
      events.push(`project:${entityId}`);
    });

    events.push("chat:message-one");
    await expect(
      router.route({
        chatId: "chat-one",
        entityId: "message-one",
        ownerId: "owner-one",
        resource: "chat-message",
      }),
    ).rejects.toThrow("database unavailable");
    await router.route({
      chatId: "chat-one",
      entityId: "message-one",
      ownerId: "owner-one",
      resource: "chat-message",
    });

    expect(load).toHaveBeenCalledTimes(2);
    expect(events).toEqual(["chat:message-one", "project:message-one"]);
  });
});
