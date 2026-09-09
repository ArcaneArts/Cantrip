import { randomUUID } from "node:crypto";
import Fastify from "fastify";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { nativeHistoryTurnReadResponseSchema } from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";
import { protectedChatFields } from "./private-label-fixture.js";
import { installChatNativeHistoryTurnRoutes } from "../src/app/routes/chat-native-history-turns.js";
let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
const app = Fastify();
let ownerId = LOCAL_USER_ID;
const sourceIds: string[] = [];
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
  const [chat] = await fixture.db
    .select()
    .from(schema.chats)
    .where(eq(schema.chats.id, fixture.chatId));
  const [worker] = await fixture.db
    .select()
    .from(schema.workers)
    .where(eq(schema.workers.id, fixture.workerId));
  const other = await fixture.repository.createChat(ownerId, chat!.projectId!, {
    ...protectedChatFields(),
    worktreeMode: "agent-managed",
  });
  for (let i = 0; i < 3; i++) {
    const bindingId = randomUUID();
    sourceIds.push(bindingId);
    const workerId = i === 1 ? randomUUID() : fixture.workerId;
    if (i === 1)
      await fixture.db
        .insert(schema.workers)
        .values({ ...worker!, id: workerId });
    await fixture.db.insert(schema.nativeHistoryBindings).values({
      id: bindingId,
      ownerId,
      workerId,
      chatId: i === 2 ? other!.id : fixture.chatId,
      threadId: i === 2 ? "foreign-thread" : "thread",
      projectId: chat!.projectId!,
      worktreeId: chat!.activeWorktreeId!,
    });
    await fixture.db.insert(schema.nativeHistoryTurns).values({
      bindingId,
      turnId: "turn",
      revision: i === 0 ? 30 : 1,
      ordinal: 0,
      status: "completed",
      startedAtMs: 1000,
      completedAtMs: 2000,
      metadata: settingsEnvelope,
      payloadDigest: String(i).repeat(64),
    });
  }
  installChatNativeHistoryTurnRoutes(app, {
    applicationOwnerId: () => ownerId,
    repository: fixture.repository,
  });
}, 60_000);
afterAll(async () => {
  await app.close();
  await fixture?.close();
});
const read = (turns = [{ threadId: "thread", turnId: "turn" }]) =>
  app.inject({
    method: "POST",
    url: `/api/chats/${fixture.chatId}/native-history/turns/read`,
    payload: { turns },
  });
describe("owner native turn archive read", () => {
  it("returns every opaque worker binding candidate without selecting a larger revision", async () => {
    const response = await read();
    expect(response.statusCode).toBe(200);
    const parsed = nativeHistoryTurnReadResponseSchema.parse(response.json());
    expect(parsed.turns.map((entry) => entry.bindingId).sort()).toEqual(
      sourceIds.slice(0, 2).sort(),
    );
    expect(parsed.turns.map((entry) => entry.turn.revision).sort()).toEqual([
      1, 30,
    ]);
    expect(
      parsed.turns.every(
        (entry) =>
          JSON.stringify(entry.turn.metadata) ===
          JSON.stringify(settingsEnvelope),
      ),
    ).toBe(true);
    expect(response.body).not.toMatch(
      /initialSettings|private-model|protectedApiKey/,
    );
  });
  it("enforces chat ownership and exact thread/turn pairs", async () => {
    ownerId = "different-owner";
    try {
      expect((await read()).statusCode).toBe(404);
    } finally {
      ownerId = LOCAL_USER_ID;
    }
    expect(
      (await read([{ threadId: "foreign-thread", turnId: "turn" }])).json()
        .turns,
    ).toEqual([]);
    expect(
      (
        await read([
          { threadId: "thread", turnId: "absent" },
          { threadId: "absent", turnId: "turn" },
        ])
      ).json().turns,
    ).toEqual([]);
    expect(
      (
        await app.inject({
          method: "POST",
          url: `/api/chats/${fixture.chatId}/native-history/turns/read`,
          payload: {
            turns: [
              { threadId: "thread", turnId: "turn", ownerId: LOCAL_USER_ID },
            ],
          },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("reads committed historical captures after the live native thread has been replaced", async () => {
    await fixture.db
      .update(schema.chatRuntimeSessions)
      .set({ codexThreadId: "new-current-thread" })
      .where(eq(schema.chatRuntimeSessions.chatId, fixture.chatId));
    const response = await read();
    expect(response.statusCode).toBe(200);
    expect(response.json().turns).toHaveLength(2);
  });
});
