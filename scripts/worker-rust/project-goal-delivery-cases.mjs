import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { decryptChatMessageProtectedContent } from "../../packages/crypto/dist/index.js";
import { projectGoalObservationSchema } from "../../packages/protocol/dist/index.js";
import { ProjectGoalDelivery } from "../../cantrip_worker/src/project-goal-delivery.ts";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export async function verifyProjectGoalDelivery({
  expectSuccess,
  start,
  stop,
  available,
  directory,
  oracle,
  workerId,
  modelCalls,
  attach,
  provider,
}) {
  const seen = [];
  const acknowledged = [];
  const arrived = Promise.withResolvers();
  const replayed = Promise.withResolvers();
  const objective = "Private material for the Project Goal fixture.";
  const chatId = randomUUID();
  const retainedChat = randomUUID();
  const retainedThread = randomUUID();
  let accept = false;
  attach((source) => {
    const fact = projectGoalObservationSchema.parse(source);
    assert.equal(fact.workerId, workerId);
    assert.ok([chatId, retainedChat].includes(fact.chatId));
    assert.ok(!JSON.stringify(fact).includes(objective));
    seen.push(fact);
    arrived.resolve();
    if (!accept) return { accepted: false, reason: "unbound-thread" };
    acknowledged.push(fact);
    if (acknowledged.length === 4) replayed.resolve();
    return { accepted: true };
  });
  try {
    const calls = modelCalls();
    await start();
    const command = { chatId, provider, permissionProfileId: ":read-only" };
    const { goal } = await expectSuccess({
      ...command,
      type: "chat.goal.create",
      objective,
      tokenBudget: 5000,
    });
    await available(arrived.promise);
    assert.equal(seen[0].snapshot.goal.status, "active");
    assert.equal(seen[0].threadId, goal.threadId);
    const target = { ...command, threadId: goal.threadId };
    await expectSuccess({
      ...target,
      type: "chat.goal.update",
      status: "paused",
    });
    assert.deepEqual(
      await expectSuccess({ ...target, type: "chat.goal.clear" }),
      { cleared: true },
    );
    await stop();

    const namespace = sha256(
      JSON.stringify([oracle.serverIdentity(), oracle.ownerId(), workerId]),
    );
    const file = (thread) =>
      path.join(
        directory,
        "goal-observations",
        namespace,
        sha256(thread) + ".json",
      );
    const read = async (thread) =>
      JSON.parse(await readFile(file(thread), "utf8"));
    const saved = await read(goal.threadId);
    assert.equal(saved.formatVersion, 1);
    assert.equal(saved.delivered, false);
    assert.deepEqual(
      saved.pending.map((fact) => fact.revision),
      [1, 2, 3],
    );
    assert.deepEqual(
      saved.pending.map((fact) => fact.snapshot.goal?.status ?? null),
      ["active", "paused", null],
    );
    assert.deepEqual(saved.pending[0], seen[0]);
    assert.deepEqual(saved.observation, saved.pending.at(-1));
    assert.ok(!JSON.stringify(saved).includes(objective));
    if (process.platform !== "win32")
      assert.equal((await stat(file(goal.threadId))).mode & 0o777, 0o600);
    for (const fact of saved.pending.slice(0, 2)) {
      const opaque = fact.snapshot.goal.protectedObjective;
      const { key, keyRevision } = oracle.componentKey("chat-content");
      const content = await decryptChatMessageProtectedContent({
        ownerId: oracle.ownerId(),
        messageId: opaque.id,
        encrypted: opaque.protectedContent,
        publicClassification: opaque.classification,
        componentKey: key,
        keyRevision,
      });
      assert.deepEqual(content.content, [{ type: "text", text: objective }]);
    }

    // The reference writer produces a pending file in the same stopped fixture.
    const nodeSent = Promise.withResolvers();
    const retained = new ProjectGoalDelivery({
      directory,
      workerId,
      generation: randomUUID,
      service: oracle,
      send: async () => {
        nodeSent.resolve();
        return { accepted: false, reason: "unbound-thread" };
      },
      onError: () => {},
    });
    try {
      retained.watch(retainedThread, retainedChat);
      retained.observe(retainedThread, { ...goal, threadId: retainedThread });
      await available(nodeSent.promise);
    } finally {
      await retained.stop();
    }
    const fromNode = await read(retainedThread);
    assert.equal(fromNode.pending.length, 1);

    accept = true;
    await start();
    await available(replayed.promise);
    const signal = AbortSignal.timeout(5000);
    // The fixture sees the HTTP request before the worker receives the ack
    // and commits it to disk. Wait for that actual commit before shutting down.
    while (
      !(await read(goal.threadId)).delivered ||
      !(await read(retainedThread)).delivered
    ) {
      await delay(20, undefined, { signal });
    }
    await stop();
    assert.deepEqual(
      acknowledged.filter((fact) => fact.chatId === chatId),
      saved.pending,
    );
    assert.deepEqual(
      acknowledged.find((fact) => fact.chatId === retainedChat),
      fromNode.pending[0],
    );
    for (const [thread, prior] of [
      [goal.threadId, saved],
      [retainedThread, fromNode],
    ]) {
      assert.deepEqual(await read(thread), {
        ...prior,
        pending: [],
        delivered: true,
      });
    }
    assert.equal(modelCalls(), calls);
  } finally {
    attach(undefined);
  }
  console.log(
    "Published native Project Goal lifecycle facts and drained matching Rust and Node outboxes after restart.",
  );
}
