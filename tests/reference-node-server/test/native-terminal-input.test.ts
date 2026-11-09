import { createHash, randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import {
  nativeCommandAdmissionSchema,
  queuedPromptOpaqueContentSchema,
} from "@cantrip/protocol";
import * as schema from "../src/db/schema.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeEach(async () => {
  f = await createNativeSettingsFixture();
  await f.db.execute(
    sql`INSERT INTO model_profiles(id,owner_id,name,created_at,updated_at) VALUES('terminal-model',${owner},'Terminal model',now(),now())`,
  );
}, 120_000);
afterEach(async () => {
  await f?.close();
});

async function input() {
  const id = randomUUID(),
    message = randomUUID();
  const content = {
    formatVersion: 1,
    keyRevision: 1,
    envelope: settingsEnvelope,
  };
  const prompt = queuedPromptOpaqueContentSchema.parse({
    id,
    classification: { mode: "default", attachmentIds: [] },
    protectedContent: content,
    modelId: "terminal-model",
    idempotencyKey: `terminal:${id}`,
    pendingMessage: {
      id: message,
      classification: { role: "user", mode: "default", attachmentIds: [] },
      protectedContent: content,
      idempotencyKey: `terminal:${message}`,
    },
    nativeAction: "literal",
    executionMethod: "turn/start",
    nativeClientUserMessageId: `native:${message}`,
    protectedNativeInput: settingsEnvelope,
  });
  return nativeCommandAdmissionSchema.parse({
    ...(await f.input("terminal")),
    method: "turn/start",
    session: {
      ...(await f.input("terminal")).session,
      runtimeGeneration: randomUUID(),
    },
    intent: {
      scope: "thread",
      nativeClientUserMessageId: prompt.nativeClientUserMessageId,
    },
    retainedInput: { prompt, attachments: [] },
  });
}
function recovery(
  request: Awaited<ReturnType<typeof input>>,
  generation: string,
) {
  const workerGeneration = randomUUID();
  return {
    serverId: "server",
    workerId: f.workerId,
    workerGeneration: randomUUID(),
    record: {
      key: createHash("sha256")
        .update(
          JSON.stringify([
            workerGeneration,
            request.session.runtimeGeneration,
            generation,
          ]),
        )
        .digest("hex"),
      workerGeneration,
      state: "waiting" as const,
      order: 1,
      revision: 1,
      everGranted: false,
      outcome: null,
      identity: {
        operationId: generation,
        providerId: "provider",
        runtimeGeneration: request.session.runtimeGeneration!,
        recoveryKey: `native-command:${request.operationId}`,
        chatId: f.chatId,
        projectId: request.session.projectId,
        recovery: {
          commandId: request.operationId,
          commandGeneration: generation,
          messageId: request.retainedInput!.prompt.nativeClientUserMessageId!,
          threadId: request.session.threadId,
        },
      },
    },
  };
}

it("commits the original encrypted item and claim with admission and retains them after storage reopen", async () => {
  const request = await input();
  const result = await f.commands.admit(owner, request);
  expect(result.receipt.status).toBe("accepted");
  await f.restart();
  const [prompt] = await f.db.select().from(schema.queuedPrompts);
  const [claim] = await f.db.select().from(schema.managedQueueClaims);
  const [command] = await f.db
    .select()
    .from(schema.nativeCommands)
    .where(eq(schema.nativeCommands.operationId, request.operationId));
  expect(prompt).toMatchObject({
    id: request.retainedInput!.prompt.id,
    revision: 0,
    state: "claimed",
    opaqueContent: request.retainedInput!.prompt,
  });
  expect(claim).toMatchObject({
    status: "accepted",
    operationId: request.operationId,
    operationGeneration: result.receipt.operationGeneration,
    promptId: prompt.id,
  });
  expect(command).toMatchObject({
    logicalOperationId: null,
    logicalClientMessageId: null,
  });
  await expect(f.commands.admit(owner, request)).resolves.toMatchObject({
    replayed: true,
  });
  expect(await f.db.select().from(schema.queuedPrompts)).toHaveLength(1);
});

it("rolls back native admission and queue insertion when the actual claim write fails", async () => {
  await f.db.execute(
    sql.raw(
      "CREATE FUNCTION fail_terminal_claim() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'terminal claim write failure'; END$$",
    ),
  );
  await f.db.execute(
    sql.raw(
      "CREATE TRIGGER fail_terminal_claim BEFORE INSERT ON managed_queue_claims FOR EACH ROW EXECUTE FUNCTION fail_terminal_claim()",
    ),
  );
  await expect(f.commands.admit(owner, await input())).rejects.toMatchObject({
    cause: { code: "P0001", message: "terminal claim write failure" },
  });
  expect(await f.db.select().from(schema.nativeCommands)).toHaveLength(0);
  expect(await f.db.select().from(schema.queuedPrompts)).toHaveLength(0);
  expect(
    (await f.repository.getChatExecutionContext(owner, f.chatId))?.status,
  ).toBe("idle");
});

it("rejects conflicting native input identity without acquiring a lane or a queue item", async () => {
  const request = await input();
  request.intent.nativeClientUserMessageId = "different-native-user";
  await expect(f.commands.admit(owner, request)).rejects.toThrow(
    "invalid-terminal-input",
  );
  expect(await f.db.select().from(schema.nativeCommands)).toHaveLength(0);
  expect(await f.db.select().from(schema.queuedPrompts)).toHaveLength(0);
  expect(
    (await f.repository.getChatExecutionContext(owner, f.chatId))?.status,
  ).toBe("idle");
});

it("cannot adopt an existing queued item for a newly admitted terminal command", async () => {
  const request = await input();
  await f.repository.createEncryptedQueuedPrompt(
    owner,
    f.chatId,
    request.retainedInput!.prompt,
    [],
  );
  await expect(f.commands.admit(owner, request)).rejects.toThrow(
    "terminal-input-conflict",
  );
  expect(await f.db.select().from(schema.nativeCommands)).toHaveLength(0);
  const prompts = await f.db.select().from(schema.queuedPrompts);
  expect(prompts).toHaveLength(1);
  expect(prompts[0]).toMatchObject({
    id: request.retainedInput!.prompt.id,
    state: "pending",
  });
  expect(await f.db.select().from(schema.managedQueueClaims)).toHaveLength(0);
});

it("returns the same never-granted terminal input to its queue only with correlated journal evidence", async () => {
  const request = await input();
  const { receipt } = await f.commands.admit(owner, request);
  const proof = recovery(request, receipt.operationGeneration);
  await expect(
    f.commands.reconcileInference(owner, proof),
  ).resolves.toMatchObject({ disposition: "requeued" });
  await expect(
    f.commands.reconcileInference(owner, proof),
  ).resolves.toMatchObject({ disposition: "requeued" });
  const [prompt] = await f.db.select().from(schema.queuedPrompts);
  const [claim] = await f.db.select().from(schema.managedQueueClaims);
  expect(prompt).toMatchObject({
    id: request.retainedInput!.prompt.id,
    state: "pending",
    revision: 0,
  });
  expect(claim.status).toBe("deferred");
  expect(
    (await f.repository.getChatExecutionContext(owner, f.chatId))?.status,
  ).toBe("idle");
});

it.each(["granted", "same-worker", "wrong-message"] as const)(
  "refuses %s recovery without changing the accepted source",
  async (kind) => {
    const request = await input();
    const { receipt } = await f.commands.admit(owner, request);
    const proof = recovery(request, receipt.operationGeneration);
    if (kind === "granted") proof.record.everGranted = true;
    if (kind === "same-worker")
      proof.workerGeneration = proof.record.workerGeneration;
    if (kind === "wrong-message")
      proof.record.identity.recovery.messageId = randomUUID();
    await expect(
      f.commands.reconcileInference(owner, proof),
    ).resolves.toMatchObject({ disposition: "unresolved" });
    expect((await f.db.select().from(schema.queuedPrompts))[0].state).toBe(
      "claimed",
    );
    expect(
      (await f.db.select().from(schema.managedQueueClaims))[0].status,
    ).toBe("accepted");
  },
);
