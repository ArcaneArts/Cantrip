import { randomUUID } from "node:crypto";

import type {
  ChatCreate,
  ChatMessage,
  ChatMessageCreate,
  ChatSummary,
  ProjectCreate,
  ProjectSummary,
  UserSummary,
  WorkerHeartbeat,
  WorkerSummary,
} from "@cantrip/protocol";
import { and, asc, desc, eq } from "drizzle-orm";
import type { PgDatabase } from "drizzle-orm/pg-core";
import type { PgQueryResultHKT } from "drizzle-orm/pg-core/session";

import * as schema from "./schema.js";

export const LOCAL_USER_ID = "00000000-0000-0000-0000-000000000001";
const SERVER_ID_STATE_KEY = "server-id";
const ONLINE_WINDOW_MS = 15_000;

type RepositoryDatabase = PgDatabase<PgQueryResultHKT, typeof schema>;

function toISOString(value: Date): string {
  return value.toISOString();
}

function firstOrThrow<T>(rows: T[], operation: string): T {
  const row = rows[0];
  if (!row) {
    throw new Error(`Database returned no row after ${operation}.`);
  }
  return row;
}

function toProjectSummary(
  project: typeof schema.projects.$inferSelect,
): ProjectSummary {
  return {
    id: project.id,
    name: project.name,
    createdAt: toISOString(project.createdAt),
    updatedAt: toISOString(project.updatedAt),
  };
}

function toChatSummary(chat: typeof schema.chats.$inferSelect): ChatSummary {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    status: chat.status as ChatSummary["status"],
    activeWorkerId: chat.activeWorkerId,
    createdAt: toISOString(chat.createdAt),
    updatedAt: toISOString(chat.updatedAt),
  };
}

function toWorkerSummary(
  worker: typeof schema.workers.$inferSelect,
): WorkerSummary {
  return {
    workerId: worker.id,
    name: worker.name,
    platform: worker.platform,
    architecture: worker.architecture,
    codexVersion: worker.codexVersion,
    startedAt: toISOString(worker.startedAt),
    lastSeenAt: toISOString(worker.lastSeenAt),
    online: Date.now() - worker.lastSeenAt.getTime() <= ONLINE_WINDOW_MS,
  };
}

function toChatMessage(
  message: typeof schema.chatMessages.$inferSelect,
): ChatMessage {
  return {
    id: message.id,
    chatId: message.chatId,
    sequence: message.sequence,
    role: message.role as ChatMessage["role"],
    content: message.content,
    createdAt: toISOString(message.createdAt),
  };
}

export class ServerRepository {
  constructor(private readonly database: RepositoryDatabase) {}

  async ensureLocalIdentity(): Promise<UserSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.users)
      .values({
        id: LOCAL_USER_ID,
        kind: "anonymous",
        displayName: "Local User",
        email: null,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.users.id,
        set: { updatedAt: now },
      })
      .returning();
    const user = firstOrThrow(result, "ensuring the local user");

    return {
      id: user.id,
      kind: "anonymous",
      displayName: user.displayName,
      email: user.email,
    };
  }

  async getOrCreateServerId(): Promise<string> {
    const existing = await this.database
      .select()
      .from(schema.systemState)
      .where(eq(schema.systemState.key, SERVER_ID_STATE_KEY))
      .limit(1);
    const existingId = (existing[0]?.value as { id?: unknown } | undefined)?.id;

    if (typeof existingId === "string" && existingId.length > 0) {
      return existingId;
    }

    const id = randomUUID();
    await this.database
      .insert(schema.systemState)
      .values({ key: SERVER_ID_STATE_KEY, value: { id } })
      .onConflictDoUpdate({
        target: schema.systemState.key,
        set: { value: { id }, updatedAt: new Date() },
      });
    return id;
  }

  async recordWorker(heartbeat: WorkerHeartbeat): Promise<WorkerSummary> {
    const now = new Date();
    const result = await this.database
      .insert(schema.workers)
      .values({
        id: heartbeat.workerId,
        ownerId: LOCAL_USER_ID,
        name: heartbeat.name,
        platform: heartbeat.platform,
        architecture: heartbeat.architecture,
        codexVersion: heartbeat.codexVersion,
        startedAt: new Date(heartbeat.startedAt),
        lastSeenAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: schema.workers.id,
        set: {
          name: heartbeat.name,
          platform: heartbeat.platform,
          architecture: heartbeat.architecture,
          codexVersion: heartbeat.codexVersion,
          startedAt: new Date(heartbeat.startedAt),
          lastSeenAt: now,
          updatedAt: now,
        },
      })
      .returning();
    const worker = firstOrThrow(result, "recording a worker heartbeat");

    return toWorkerSummary(worker);
  }

  async listWorkers(ownerId: string): Promise<WorkerSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.ownerId, ownerId))
      .orderBy(asc(schema.workers.name));
    return rows.map(toWorkerSummary);
  }

  async onlineWorkerCount(ownerId: string): Promise<number> {
    const workers = await this.listWorkers(ownerId);
    return workers.filter((worker) => worker.online).length;
  }

  async listProjects(ownerId: string): Promise<ProjectSummary[]> {
    const rows = await this.database
      .select()
      .from(schema.projects)
      .where(eq(schema.projects.ownerId, ownerId))
      .orderBy(desc(schema.projects.updatedAt));
    return rows.map(toProjectSummary);
  }

  async createProject(
    ownerId: string,
    input: ProjectCreate,
  ): Promise<ProjectSummary> {
    const result = await this.database
      .insert(schema.projects)
      .values({ id: randomUUID(), ownerId, name: input.name })
      .returning();
    const project = firstOrThrow(result, "creating a project");
    return toProjectSummary(project);
  }

  async listChats(ownerId: string, projectId: string): Promise<ChatSummary[]> {
    const rows = await this.database
      .select({ chat: schema.chats })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chats.projectId, projectId))
      .orderBy(desc(schema.chats.updatedAt));
    return rows.map(({ chat }) => toChatSummary(chat));
  }

  async createChat(
    ownerId: string,
    projectId: string,
    input: ChatCreate,
  ): Promise<ChatSummary | null> {
    const project = await this.database
      .select({ id: schema.projects.id })
      .from(schema.projects)
      .where(
        and(
          eq(schema.projects.id, projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .limit(1);

    if (!project[0]) {
      return null;
    }

    if (input.workerId) {
      const worker = await this.database
        .select({ id: schema.workers.id })
        .from(schema.workers)
        .where(
          and(
            eq(schema.workers.id, input.workerId),
            eq(schema.workers.ownerId, ownerId),
          ),
        )
        .limit(1);
      if (!worker[0]) {
        return null;
      }
    }

    const result = await this.database
      .insert(schema.chats)
      .values({
        id: randomUUID(),
        projectId,
        title: input.title,
        activeWorkerId: input.workerId ?? null,
      })
      .returning();
    const chat = firstOrThrow(result, "creating a chat");

    if (input.workerId) {
      await this.database.insert(schema.chatRuntimeSessions).values({
        id: randomUUID(),
        chatId: chat.id,
        workerId: input.workerId,
      });
    }

    return toChatSummary(chat);
  }

  async listMessages(ownerId: string, chatId: string): Promise<ChatMessage[]> {
    const rows = await this.database
      .select({ message: schema.chatMessages })
      .from(schema.chatMessages)
      .innerJoin(schema.chats, eq(schema.chats.id, schema.chatMessages.chatId))
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chatMessages.chatId, chatId))
      .orderBy(asc(schema.chatMessages.sequence));
    return rows.map(({ message }) => toChatMessage(message));
  }

  async appendMessage(
    ownerId: string,
    chatId: string,
    input: ChatMessageCreate,
  ): Promise<ChatMessage | null> {
    const chat = await this.database
      .select({ id: schema.chats.id })
      .from(schema.chats)
      .innerJoin(
        schema.projects,
        and(
          eq(schema.projects.id, schema.chats.projectId),
          eq(schema.projects.ownerId, ownerId),
        ),
      )
      .where(eq(schema.chats.id, chatId))
      .limit(1);

    if (!chat[0]) {
      return null;
    }

    if (input.idempotencyKey) {
      const existing = await this.database
        .select()
        .from(schema.chatMessages)
        .where(
          and(
            eq(schema.chatMessages.chatId, chatId),
            eq(schema.chatMessages.idempotencyKey, input.idempotencyKey),
          ),
        )
        .limit(1);
      if (existing[0]) {
        return toChatMessage(existing[0]);
      }
    }

    const result = await this.database
      .insert(schema.chatMessages)
      .values({
        id: randomUUID(),
        chatId,
        role: input.role,
        content: input.content,
        idempotencyKey: input.idempotencyKey ?? null,
      })
      .returning();
    const message = firstOrThrow(result, "appending a chat message");
    await this.database
      .update(schema.chats)
      .set({ updatedAt: new Date() })
      .where(eq(schema.chats.id, chatId));
    return toChatMessage(message);
  }
}
