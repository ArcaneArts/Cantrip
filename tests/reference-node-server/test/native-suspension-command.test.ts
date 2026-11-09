import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  nativeCommandAdmissionSchema,
  type NativeCommandSettlement,
} from "@cantrip/protocol";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
beforeAll(async () => {
  f = await createNativeSettingsFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});

it("commits control and receipt together, fences stale ACKs and retains held execution after transport failure", async () => {
  const owner = LOCAL_USER_ID,
    workerGeneration = randomUUID();
  const base = await f.input();
  const start = nativeCommandAdmissionSchema.parse({
    ...base,
    method: "turn/start",
    intent: { scope: "thread" },
  });
  const root = (await f.commands.admit(owner, start)).receipt;
  expect(root.startsExecution).toBe(true);
  await f.commands.dispatch(owner, {
    ...start,
    operationGeneration: root.operationGeneration,
    workerGeneration,
  });
  await f.commands.settle(owner, {
    workerId: f.workerId,
    operationId: start.operationId,
    operationGeneration: root.operationGeneration,
    status: "applied",
    resultDigest: "b".repeat(64),
    protectedResult: settingsEnvelope,
    rejectionCode: null,
    executionComplete: false,
    reconciliation: {
      nativeTurnId: "original-turn",
      runtimeGeneration: base.session.runtimeGeneration!,
    },
  });
  const active = { threadId: base.session.threadId!, turnId: "original-turn" };
  const read = () => f.repository.nativeSuspensions.read(owner, f.chatId);
  const context = () => f.repository.getChatExecutionContext(owner, f.chatId);
  const control = async (
    method: "turn/pause" | "turn/interrupt",
    paused = true,
  ) => {
    const input = nativeCommandAdmissionSchema.parse({
      ...base,
      operationId: randomUUID(),
      method,
      expectedActivationGeneration: root.activationGeneration,
      intent: {
        scope: "thread",
        expectedTurnId: active.turnId,
        durableSuspension: true,
        workerGeneration,
        ...(method === "turn/pause" ? { paused, resumeAutonomy: !paused } : {}),
      },
    });
    const receipt = (await f.commands.admit(owner, input)).receipt;
    expect(receipt.status, receipt.rejectionCode ?? "control rejected").toBe(
      "accepted",
    );
    await f.commands.dispatch(owner, {
      workerId: f.workerId,
      operationId: input.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: input.payloadDigest,
      session: input.session,
      workerGeneration,
    });
    return {
      workerId: f.workerId,
      workerGeneration,
      operationId: input.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied",
      resultDigest: "c".repeat(64),
      protectedResult: settingsEnvelope,
      durableSuspension: true,
      rejectionCode: null,
      executionComplete: false,
    } satisfies NativeCommandSettlement;
  };
  const evidence = {
    suspension: { ...active, checkpointId: "checkpoint", revision: 1 },
    storageId: randomUUID(),
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  const pause = await control("turn/pause");
  expect(await read()).toMatchObject({
    phase: "pausing",
    checkpoint: null,
    active,
  });
  expect((await context())?.automationPaused).toBe(true);
  await expect(f.commands.settle(owner, pause)).rejects.toMatchObject({
    code: "suspension-evidence-required",
  });
  expect(
    (
      await f.commands.get(
        owner,
        f.workerId,
        pause.operationId,
        pause.operationGeneration,
      )
    ).status,
  ).toBe("dispatched");
  const pauseAck = { ...pause, suspensionEvidence: evidence };
  await f.commands.settle(owner, pauseAck);
  await f.commands.settle(owner, pauseAck);
  expect(await read()).toMatchObject({ phase: "paused", checkpoint: evidence });
  const transport = {
    workerId: f.workerId,
    operationId: start.operationId,
    operationGeneration: root.operationGeneration,
    status: "applied" as const,
    resultDigest: null,
    protectedResult: null,
    terminalResult: {
      resultDigest: "d".repeat(64),
      protectedResult: settingsEnvelope,
    },
    executionComplete: true,
    executionStatus: "failed" as const,
    rejectionCode: null,
    reconciliation: {
      nativeTurnId: active.turnId,
      runtimeGeneration: base.session.runtimeGeneration!,
    },
  };
  await expect(f.commands.settle(owner, transport)).rejects.toMatchObject({
    code: "suspended-execution-not-terminal",
  });
  expect((await context())?.status).toBe("running");
  const resume = await control("turn/pause", false);
  expect(await read()).toMatchObject({
    phase: "resuming",
    checkpoint: evidence,
  });
  expect((await context())?.automationPaused).toBe(true);
  await expect(f.commands.settle(owner, pauseAck)).rejects.toMatchObject({
    code: "suspension-actor-stale",
  });
  await expect(
    f.commands.settle(owner, { ...resume, workerGeneration: randomUUID() }),
  ).rejects.toMatchObject({ code: "suspension-actor-stale" });
  // Exercise an actual failed SQL write. Neither half of the acknowledgement commits.
  await f.client.exec(
    `CREATE FUNCTION fail_running() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.native_suspension_state->>'phase'='running' THEN RAISE EXCEPTION 'actual running write failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_running BEFORE UPDATE ON chats FOR EACH ROW EXECUTE FUNCTION fail_running();`,
  );
  await expect(f.commands.settle(owner, resume)).rejects.toMatchObject({
    cause: { message: "actual running write failure" },
  });
  expect((await read())?.phase).toBe("resuming");
  expect(
    (
      await f.commands.get(
        owner,
        f.workerId,
        resume.operationId,
        resume.operationGeneration,
      )
    ).status,
  ).toBe("dispatched");
  await f.client.exec(
    "DROP TRIGGER fail_running ON chats; DROP FUNCTION fail_running();",
  );
  await f.commands.settle(owner, resume);
  await f.commands.settle(owner, resume);
  expect((await context())?.automationPaused).toBe(false);
  expect((await read())?.phase).toBe("running");
  const pause2 = await control("turn/pause");
  await f.commands.settle(owner, {
    ...pause2,
    suspensionEvidence: {
      ...evidence,
      suspension: { ...evidence.suspension, revision: 2 },
    },
  });
  const stop = await control("turn/interrupt");
  await expect(
    f.commands.settle(owner, { ...pause2, status: "uncertain" }),
  ).rejects.toBeDefined();
  await f.commands.settle(owner, stop);
  expect(await read()).toMatchObject({
    phase: "stopped",
    checkpoint: null,
    action: "stop",
  });
  expect((await context())?.automationPaused).toBe(true);
  await f.restart();
  expect(await read()).toMatchObject({ phase: "stopped", checkpoint: null });
  await expect(
    f.repository.nativeSuspensions.request(owner, f.chatId, "resume"),
  ).rejects.toMatchObject({ code: "suspension-not-resumable" });
}, 120_000);
