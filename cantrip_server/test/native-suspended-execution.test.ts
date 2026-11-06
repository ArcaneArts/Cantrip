import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { LOCAL_USER_ID } from "../src/db/repository.js";
import * as schema from "../src/db/schema.js";
import { retainSuspendedChatTurn } from "../src/app/runtime/retain-suspended-chat-turn.js";
import {
  createNativeSettingsFixture,
  settingsEnvelope,
} from "./native-settings-repository-fixture.js";

let fixture: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
const owner = LOCAL_USER_ID;
beforeAll(async () => {
  fixture = await createNativeSettingsFixture();
}, 120_000);
beforeEach(async () => {
  await fixture.db.execute(
    sql`UPDATE chats SET native_suspension_state=NULL,automation_paused=false,managed_autonomy_stopped=false WHERE id=${fixture.chatId}`,
  );
});
afterAll(async () => {
  await fixture?.close();
});

async function capture(origin: "gui" | "terminal") {
  const base = await fixture.input(origin);
  const session = base.session;
  const workerGeneration = randomUUID();
  const input = {
    ...base,
    method: "turn/start",
    intent: { scope: "thread" as const, settingKeys: [], expectedTurnId: null },
  };
  const { receipt: root } = await fixture.commands.admit(owner, input);
  expect(root.status).toBe("accepted");
  await fixture.commands.dispatch(owner, {
    workerId: fixture.workerId,
    workerGeneration,
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
    payloadDigest: input.payloadDigest,
    session,
  });
  const active = {
    threadId: session.threadId!,
    turnId: `turn-${root.operationId}`,
  };
  const rootAck = {
    workerId: fixture.workerId,
    operationId: root.operationId,
    operationGeneration: root.operationGeneration,
    status: "applied" as const,
    resultDigest: "b".repeat(64),
    protectedResult: settingsEnvelope,
    rejectionCode: null,
    executionComplete: false,
    reconciliation: {
      nativeTurnId: active.turnId,
      runtimeGeneration: session.runtimeGeneration!,
    },
  };
  await fixture.commands.settle(owner, rootAck);
  const control = async (stop = false) => {
    const request = {
      ...base,
      operationId: randomUUID(),
      method: stop ? "turn/interrupt" : "turn/pause",
      expectedActivationGeneration: root.activationGeneration,
      intent: {
        scope: "thread" as const,
        settingKeys: [],
        durableSuspension: true as const,
        workerGeneration,
        expectedTurnId: active.turnId,
        ...(stop ? {} : { paused: true, resumeAutonomy: false }),
      },
    };
    const { receipt } = await fixture.commands.admit(owner, request);
    expect(receipt.status).toBe("accepted");
    await fixture.commands.dispatch(owner, {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      payloadDigest: request.payloadDigest,
      session,
    });
    return {
      workerId: fixture.workerId,
      workerGeneration,
      operationId: receipt.operationId,
      operationGeneration: receipt.operationGeneration,
      status: "applied" as const,
      resultDigest: "c".repeat(64),
      protectedResult: settingsEnvelope,
      rejectionCode: null,
      executionComplete: false,
      durableSuspension: true as const,
    };
  };
  const pause = await control();
  const evidence = {
    suspension: { ...active, checkpointId: randomUUID(), revision: 1 },
    storageId: randomUUID(),
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  await fixture.commands.settle(owner, {
    ...pause,
    suspensionEvidence: evidence,
  });
  return { root, rootAck, active, evidence, control };
}

describe("committed native suspension retains execution across transport loss", () => {
  it.each(["gui", "terminal"] as const)(
    "keeps the %s root and original checkpoint through administrative cleanup and database reopen",
    async (origin) => {
      const { root, rootAck, evidence } = await capture(origin);
      const args = [
        owner,
        fixture.workerId,
        root.operationId,
        root.operationGeneration,
      ] as const;
      const rows = () =>
        fixture.db
          .select()
          .from(schema.nativeCommands)
          .where(eq(schema.nativeCommands.operationId, root.operationId));
      const before = await rows();
      expect(
        (await fixture.commands.suspendedExecution(...args))?.checkpoint,
      ).toEqual(evidence);
      expect(await fixture.commands.finishExecution(...args, "failed")).toBe(
        false,
      );
      if (origin === "gui")
        expect(
          await fixture.commands.finishLogicalGui(...args, "failed", true),
        ).toBe(false);
      expect(await rows()).toEqual(before);
      expect(
        await fixture.commands.getLogicalCompletion(
          owner,
          fixture.workerId,
          fixture.chatId,
          root.operationId,
          root.operationGeneration,
        ),
      ).toBeNull();
      const summary = vi.fn();
      const log = vi.fn();
      expect(
        await retainSuspendedChatTurn(
          {
            repository: fixture.repository,
            app: { log: { info: log } } as never,
            publishChatSummary: summary,
          },
          owner,
          fixture.workerId,
          root,
        ),
      ).toBe(true);
      expect(summary).toHaveBeenCalledWith(fixture.chatId, expect.any(String));
      expect(log).toHaveBeenCalledOnce();
      await fixture.restart();
      expect(
        (await fixture.commands.suspendedExecution(...args))?.checkpoint,
      ).toEqual(evidence);
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            owner,
            fixture.chatId,
          )
        )?.status,
      ).toBe("running");
      await fixture.commands.settle(owner, {
        ...rootAck,
        resultDigest: null,
        protectedResult: null,
        executionComplete: true,
        executionStatus: "idle",
        terminalResult: {
          resultDigest: "d".repeat(64),
          protectedResult: settingsEnvelope,
        },
        reconciliation: {
          ...rootAck.reconciliation,
          terminalStatus: "completed",
        },
      });
      expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
      if (origin === "gui") {
        await fixture.commands.finishLogicalGui(...args, "idle");
        expect((await rows())[0]!.logicalCompletedAt).not.toBeNull();
      }
      expect(
        (
          await fixture.repository.getChatExecutionContext(
            owner,
            fixture.chatId,
          )
        )?.status,
      ).toBe("idle");
    },
  );

  it("allows explicit Stop to retire a held root and fences foreign generations", async () => {
    const { root, control } = await capture("gui");
    const args = [
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
    ] as const;
    await expect(
      fixture.commands.suspendedExecution(
        owner,
        fixture.workerId,
        root.operationId,
        "foreign",
      ),
    ).rejects.toBeDefined();
    const stop = await control(true);
    expect(
      await fixture.commands.finishLogicalGui(...args, "failed", true),
    ).toBe(false);
    await fixture.commands.settle(owner, stop);
    expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
    expect(await fixture.commands.finishLogicalGui(...args, "idle")).toBe(true);
  });

  it("releases the root when native ends before the Stop receipt arrives", async () => {
    const { root, rootAck, control } = await capture("gui");
    const args = [
      owner,
      fixture.workerId,
      root.operationId,
      root.operationGeneration,
    ] as const;
    const stop = await control(true);
    await fixture.commands.settle(owner, {
      ...rootAck,
      resultDigest: null,
      protectedResult: null,
      executionComplete: true,
      executionStatus: "idle",
      terminalResult: {
        resultDigest: "d".repeat(64),
        protectedResult: settingsEnvelope,
      },
      reconciliation: {
        ...rootAck.reconciliation,
        terminalStatus: "interrupted",
      },
    });
    expect(await fixture.commands.suspendedExecution(...args)).toBeNull();
    expect(
      (await fixture.repository.getChatExecutionContext(owner, fixture.chatId))
        ?.status,
    ).toBe("idle");
    await fixture.commands.settle(owner, stop);
    await fixture.commands.finishLogicalGui(...args, "idle");
    expect(
      (await fixture.repository.nativeSuspensions.read(owner, fixture.chatId))
        ?.phase,
    ).toBe("stopped");
  });
});
