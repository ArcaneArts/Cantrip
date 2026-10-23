import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { TaskRetryRepository } from "../src/db/task-retries.js";
import * as schema from "../src/db/schema.js";
import {
  protectedChatFields,
  protectedProjectFields,
} from "./private-label-fixture.js";

const client = new PGlite();
const database = drizzle(client, { schema });
const retries = new TaskRetryRepository(database);
const ownerId = randomUUID(),
  workerId = randomUUID(),
  projectId = randomUUID();
const sourceId = randomUUID(),
  worktreeId = randomUUID();
const ciphertext = {
  formatVersion: 1 as const,
  keyRevision: 1,
  envelope: {
    version: 1 as const,
    algorithm: "AES-256-GCM" as const,
    keyRevision: 1,
    nonce: "AAAAAAAAAAAAAAAA",
    ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
  },
};
beforeAll(async () => {
  await migrate(database, {
    migrationsFolder: fileURLToPath(new URL("../drizzle", import.meta.url)),
  });
  await database
    .insert(schema.users)
    .values({ id: ownerId, kind: "anonymous", displayName: "Retry fixture" });
  await database.insert(schema.workers).values({
    id: workerId,
    ownerId,
    name: "Fixture",
    platform: "linux",
    architecture: "x64",
    startedAt: new Date(),
    lastSeenAt: new Date(),
  });
  await database.insert(schema.projects).values({
    id: projectId,
    ownerId,
    protectedLabel: protectedProjectFields(projectId).nameProtection,
    githubRepositoryBlindIndex: randomUUID(),
  });
  await database.insert(schema.projectSources).values({
    id: sourceId,
    projectId,
    workerId,
    absolutePath: "/fixture",
    displayPath: "/fixture",
  });
  await database.insert(schema.projectWorktrees).values({
    id: worktreeId,
    projectSourceId: sourceId,
    workerId,
    name: "Primary",
    isPrimary: true,
    isDefault: true,
    origin: "cantrip",
    lifecycleState: "ready",
    absolutePath: "/fixture",
    displayPath: "/fixture",
  });
}, 60000);
afterAll(async () => {
  await client.close();
});
async function task() {
  const id = randomUUID();
  await database.insert(schema.chats).values({
    id,
    ownerId,
    projectId,
    experience: "task",
    activeWorkerId: workerId,
    activeWorktreeId: worktreeId,
    protectedLabel: protectedChatFields(id).titleProtection,
  });
  await database
    .insert(schema.tasks)
    .values({ chatId: id, state: "failed", protectedContent: ciphertext });
  return id;
}
async function record(chatId: string) {
  return (
    await database
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.chatId, chatId))
  )[0]!.automaticRetry!;
}

describe("durable Task automatic retry ledger", () => {
  it("does not let paused or future retries starve another due Task", async () => {
    const pausedIds = [];
    for (let i = 0; i < 5; i++) {
      const id = await task();
      pausedIds.push(id);
      await retries.noteFailure(ownerId, id, "paused", "timeout", 0);
      await database
        .update(schema.chats)
        .set({ automationPaused: true })
        .where(eq(schema.chats.id, id));
    }
    const future = await task(),
      due = await task();
    await retries.noteFailure(ownerId, future, "later", "timeout", 5000);
    await retries.noteFailure(ownerId, due, "now", "timeout", 0);
    const candidates = await retries.listCandidates(5000);
    expect(candidates.map(({ chatId }) => chatId)).toContain(due);
    expect(candidates.map(({ chatId }) => chatId)).not.toContain(future);
    expect(candidates.some(({ chatId }) => pausedIds.includes(chatId))).toBe(
      false,
    );
  });
  it("recovers a claim after server loss without allowing its stale finisher to overwrite the new claim", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "first", "timeout", 0);
    const old = (await retries.claimDue(ownerId, id, 5000))!;
    const deadline = (await record(id)).claim!.expiresAt;
    expect(await retries.claimDue(ownerId, id, deadline - 1)).toBeNull();
    const recovered = (await new TaskRetryRepository(database).claimDue(
      ownerId,
      id,
      deadline,
    ))!;
    expect(recovered.id).not.toBe(old.id);
    expect(await retries.finish(ownerId, id, old.id)).toBe(false);
    expect((await record(id)).claim?.id).toBe(recovered.id);
  });
  it("claims at five seconds once across scheduler replicas and preserves the Task's ciphertext revision", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "timeout-1", "timeout", 0);
    expect(await retries.claimDue(ownerId, id, 4999)).toBeNull();
    const replica = new TaskRetryRepository(database);
    const claims = await Promise.all([
      retries.claimDue(ownerId, id, 5000),
      replica.claimDue(ownerId, id, 5000),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    expect((await record(id)).attempts).toEqual([5000]);
    const [row] = await database
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.chatId, id));
    expect(row!.rowVersion).toBe(1);
    expect(row!.protectedContent).toEqual(ciphertext);
    expect(await replica.claimDue(ownerId, id, 6000)).toBeNull();
  });
  it("latches the sixth recovery after five burst attempts and only an explicit reset reopens it", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "initial", "timeout", 0);
    for (let attempt = 1; attempt <= 5; attempt++) {
      const claim = await retries.claimDue(ownerId, id, attempt * 5000);
      expect(claim).toBeTruthy();
      await retries.finish(
        ownerId,
        id,
        claim!.id,
        { kind: "timeout" },
        attempt * 5000,
      );
    }
    expect(await record(id)).toMatchObject({ status: "latched", dueAt: null });
    expect(await retries.claimDue(ownerId, id, 180000)).toBeNull();
    await retries.reset(ownerId, id);
    await retries.noteFailure(
      ownerId,
      id,
      "manual-new-window",
      "timeout",
      180000,
    );
    expect(await retries.claimDue(ownerId, id, 185000)).toBeTruthy();
    expect((await record(id)).attempts).toEqual([185000]);
  });
  it("keeps rolling attempts across successful starts without a lifetime cap", async () => {
    const id = await task();
    for (let attempt = 0; attempt < 15; attempt++) {
      const now = attempt * 30000;
      await retries.noteFailure(
        ownerId,
        id,
        `failure-${attempt}`,
        "capacity",
        now,
      );
      const claim = await retries.claimDue(ownerId, id, now + 5000);
      expect(claim).toBeTruthy();
      await retries.finish(ownerId, id, claim!.id, undefined, now + 5001);
      expect((await record(id)).attempts.length).toBeLessThanOrEqual(2);
    }
  });
  it("respects individual pause, Project pause, human input, and genuine blockers", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "failure", "runtime", 0);
    await database
      .update(schema.chats)
      .set({ automationPaused: true })
      .where(eq(schema.chats.id, id));
    expect(await retries.claimDue(ownerId, id, 5000)).toBeNull();
    await database
      .update(schema.chats)
      .set({ automationPaused: false })
      .where(eq(schema.chats.id, id));
    await database
      .update(schema.projects)
      .set({ taskSchedulingPaused: true, taskSchedulingPausedAt: new Date() })
      .where(eq(schema.projects.id, projectId));
    expect(await retries.claimDue(ownerId, id, 5000)).toBeNull();
    await database
      .update(schema.projects)
      .set({ taskSchedulingPaused: false, taskSchedulingPausedAt: null })
      .where(eq(schema.projects.id, projectId));
    const requestId = randomUUID();
    await database.insert(schema.agentInteractionRequests).values({
      id: requestId,
      requestKey: requestId,
      ownerId,
      projectId,
      chatId: id,
      workerId,
      kind: "userInput",
      threadId: "native-thread",
      payload: { kind: "userInput", questions: [] },
    });
    expect(await retries.claimDue(ownerId, id, 5000)).toBeNull();
    await database
      .delete(schema.agentInteractionRequests)
      .where(eq(schema.agentInteractionRequests.id, requestId));
    await database
      .update(schema.tasks)
      .set({ state: "blocked" })
      .where(eq(schema.tasks.chatId, id));
    expect(await retries.claimDue(ownerId, id, 5000)).toBeNull();
    expect((await record(id)).attempts).toEqual([]);
  });
  it("does not let a stale attempt overwrite a newer failure or an explicit reset", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "old", "timeout", 0);
    const claim = (await retries.claimDue(ownerId, id, 5000))!;
    await retries.noteFailure(ownerId, id, "new", "capacity", 5001);
    expect(await retries.finish(ownerId, id, claim.id, undefined, 5002)).toBe(
      false,
    );
    expect(await record(id)).toMatchObject({
      failureKey: "new",
      status: "scheduled",
      dueAt: 10001,
    });
    await retries.reset(ownerId, id);
    expect(
      await retries.finish(ownerId, id, claim.id, { kind: "timeout" }, 5003),
    ).toBe(false);
    expect(
      await database
        .select({ value: schema.tasks.automaticRetry })
        .from(schema.tasks)
        .where(eq(schema.tasks.chatId, id)),
    ).toEqual([{ value: null }]);
  });
  it("cannot claim or reset another owner's Task", async () => {
    const id = await task();
    await retries.noteFailure(ownerId, id, "private", "timeout", 0);
    expect(await retries.claimDue("other-owner", id, 5000)).toBeNull();
    expect(await retries.reset("other-owner", id)).toBeNull();
    expect(await record(id)).toMatchObject({
      status: "scheduled",
      attempts: [],
    });
  });
});
