import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  nativeCommandAdmissionSchema,
  workerCommandSchema,
  type WorkerCommand,
} from "@cantrip/protocol";
import { createChatAutomationPauseRuntime } from "../src/app/runtime/chat-automation-pause-runtime.js";
import { LOCAL_USER_ID as owner } from "../src/db/repository.js";
import { createNativeSettingsFixture } from "./native-settings-repository-fixture.js";

let f: Awaited<ReturnType<typeof createNativeSettingsFixture>>;
const active = { threadId: "native-thread", turnId: "saved-turn" };
const actor = () => ({
  workerGeneration: randomUUID(),
  runtimeGeneration: randomUUID(),
  operationId: randomUUID(),
  operationGeneration: randomUUID(),
});
beforeAll(async () => {
  f = await createNativeSettingsFixture();
}, 120_000);
afterAll(async () => {
  await f?.close();
});
beforeEach(async () => {
  await f.db.execute(
    sql`UPDATE chats SET native_suspension_state=NULL,automation_paused=false,managed_autonomy_stopped=false WHERE id=${f.chatId}`,
  );
});
async function fixture(live = false) {
  const a = actor();
  if (live) {
    const base = await f.input();
    const request = nativeCommandAdmissionSchema.parse({
      ...base,
      method: "turn/start" as const,
      intent: { scope: "thread" as const },
    });
    const receipt = (await f.commands.admit(owner, request)).receipt;
    expect(receipt.status).toBe("accepted");
    await f.commands.dispatch(owner, {
      ...request,
      operationGeneration: receipt.operationGeneration,
      workerGeneration: a.workerGeneration,
    });
  }
  const request = await f.repository.nativeSuspensions.request(
    owner,
    f.chatId,
    "pause",
  );
  await f.repository.nativeSuspensions.claim(
    owner,
    f.chatId,
    request.state.controlId,
    null,
    a,
    active,
  );
  const evidence = {
    suspension: { ...active, checkpointId: "saved-checkpoint", revision: 1 },
    storageId: randomUUID(),
    runtimeVersion: "fixture",
    runtimeFingerprint: null,
  };
  await f.repository.nativeSuspensions.paused(
    owner,
    f.chatId,
    request.state.controlId,
    a,
    evidence,
  );
  const commands: WorkerCommand[] = [];
  const runtime = (
    await f.repository.getModelRuntimes(
      owner,
      (await f.repository.getUserSettings(owner)).defaultModelId!,
    )
  )[0]!;
  const wake = vi.fn(async () => {});
  const publish = vi.fn();
  const runtimeForContext = vi.fn(async () => runtime);
  let reply = async (_command: WorkerCommand) => ({ paused: false, active });
  const read = () => f.repository.nativeSuspensions.read(owner, f.chatId);
  const acknowledge = async () => {
    const state = (await read())!;
    const fresh = actor();
    await f.repository.nativeSuspensions.claim(
      owner,
      f.chatId,
      state.controlId,
      state.actor,
      fresh,
      active,
    );
    await f.repository.nativeSuspensions.running(
      owner,
      f.chatId,
      state.controlId,
      fresh,
    );
  };
  const set = createChatAutomationPauseRuntime(
    {
      repository: f.repository,
      bridge: {
        isConnected: () => true,
        request: async (_worker, command) => {
          commands.push(workerCommandSchema.parse(command));
          return reply(command);
        },
      },
      publishChatSummary: publish,
      resumeChatAutomation: wake,
      runtimeForContext,
      routePairsForConfiguration: async () =>
        [{ root: { runtime }, subagent: null }] as never,
    },
    { log: { warn: vi.fn(), info: vi.fn() } } as never,
  );
  return {
    set: () => set(owner, f.chatId, false),
    commands,
    wake,
    publish,
    read,
    evidence,
    runtimeForContext,
    acknowledge,
    reply: (fn: typeof reply) => {
      reply = fn;
    },
  };
}
describe("explicit durable Resume with real persisted pause state", () => {
  it("opens the current saved source only after explicit Resume and requires authoritative acknowledgement", async () => {
    const t = await fixture();
    expect(t.commands).toEqual([]);
    t.reply(async () => {
      await t.acknowledge();
      return { paused: false, active };
    });
    const response = await t.set();
    expect(t.commands).toHaveLength(1);
    expect(t.commands[0]).toMatchObject({
      type: "chat.suspension.resume",
      chatId: f.chatId,
      threadId: active.threadId,
      checkpoint: t.evidence,
      session: { heldSuspension: t.evidence },
      executionProfile: "ide",
    });
    expect(response).toMatchObject({
      paused: false,
      nativeSuspension: { phase: "running", resumable: false },
    });
    expect(JSON.stringify(response)).not.toContain(t.evidence.storageId);
    expect(t.wake).toHaveBeenCalledTimes(1);
  });
  it("never accepts a worker's unpaused echo without a native database acknowledgement", async () => {
    const t = await fixture();
    await expect(t.set()).rejects.toMatchObject({ statusCode: 502 });
    expect(await t.read()).toMatchObject({
      phase: "error",
      checkpoint: t.evidence,
      error: { code: "restore-failed" },
    });
    expect(t.wake).not.toHaveBeenCalled();
  });
  it("preserves concrete source failure codes and remains resumable after reopening storage", async () => {
    const t = await fixture();
    t.reply(async () => {
      throw Object.assign(new Error("private native path"), {
        code: "storage-unavailable",
      });
    });
    await expect(t.set()).rejects.toMatchObject({
      statusCode: 502,
      message:
        "The worker could not resume this saved turn. Its checkpoint has been retained.",
    });
    await f.restart();
    expect(await t.read()).toMatchObject({
      phase: "error",
      checkpoint: t.evidence,
      error: { code: "storage-unavailable" },
    });
    expect(JSON.stringify(await t.read())).not.toContain("private native path");
  });
  it("joins concurrent clicks under one durable epoch and one worker request", async () => {
    const t = await fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    t.reply(async () => {
      await gate;
      await t.acknowledge();
      return { paused: false, active };
    });
    const first = t.set();
    await vi.waitFor(() => expect(t.commands).toHaveLength(1));
    const second = t.set();
    await vi.waitFor(() => expect(t.publish).not.toHaveBeenCalled());
    release();
    expect(await second).toEqual(await first);
    expect(t.commands).toHaveLength(1);
    expect(t.wake).toHaveBeenCalledTimes(1);
  });
  it("observes a real running acknowledgement even when the transport reply is lost", async () => {
    const t = await fixture();
    t.reply(async () => {
      await t.acknowledge();
      throw new Error("lost acknowledgement");
    });
    expect(await t.set()).toMatchObject({
      paused: false,
      nativeSuspension: { phase: "running" },
    });
    expect(t.commands).toHaveLength(1);
  });
  it("does not overwrite a newer Stop when cold restoration fails", async () => {
    const t = await fixture();
    t.reply(async () => {
      await f.repository.nativeSuspensions.request(
        owner,
        f.chatId,
        "stop",
        active,
      );
      throw new Error("old restoration failed");
    });
    expect(await t.set()).toMatchObject({
      paused: true,
      nativeSuspension: { action: "stop", phase: "stopping", resumable: false },
    });
    expect((await t.read())?.error).toBeNull();
    expect(t.wake).not.toHaveBeenCalled();
  });
  it("retains native running state when queued automation cannot wake", async () => {
    const t = await fixture();
    t.wake.mockRejectedValueOnce(new Error("queue temporarily unavailable"));
    t.reply(async () => {
      await t.acknowledge();
      return { paused: false, active };
    });
    expect(await t.set()).toMatchObject({
      paused: false,
      nativeSuspension: { phase: "running" },
    });
  });
  it("retains the checkpoint when its saved provider route is unavailable", async () => {
    const t = await fixture();
    t.runtimeForContext.mockResolvedValueOnce(null as never);
    await expect(t.set()).rejects.toMatchObject({ statusCode: 409 });
    expect(t.commands).toEqual([]);
    expect(await t.read()).toMatchObject({
      phase: "error",
      checkpoint: t.evidence,
      error: { code: "runtime-unavailable" },
    });
  });
  it("uses a surviving owner without cold preparation and never replaces its claimed uncertain attempt", async () => {
    const t = await fixture(true);
    t.reply(async () => {
      await t.acknowledge();
      return { paused: false, active };
    });
    expect(await t.set()).toMatchObject({
      paused: false,
      nativeSuspension: { phase: "running" },
    });
    expect(t.commands.map((c) => c.type)).toEqual(["chat.native-control"]);
    expect(t.runtimeForContext).not.toHaveBeenCalled();
    const pause = await f.repository.nativeSuspensions.request(
      owner,
      f.chatId,
      "pause",
      active,
    );
    const current = pause.state.actor!;
    await f.repository.nativeSuspensions.claim(
      owner,
      f.chatId,
      pause.state.controlId,
      current,
      current,
      active,
    );
    await f.repository.nativeSuspensions.paused(
      owner,
      f.chatId,
      pause.state.controlId,
      current,
      t.evidence,
    );
    t.reply(async () => {
      const state = (await t.read())!;
      await f.repository.nativeSuspensions.claim(
        owner,
        f.chatId,
        state.controlId,
        state.actor,
        actor(),
        active,
      );
      throw new Error("The real native attempt lost its observer");
    });
    await expect(t.set()).rejects.toMatchObject({ statusCode: 502 });
    expect(t.commands.map((c) => c.type)).toEqual([
      "chat.native-control",
      "chat.native-control",
    ]);
    expect(t.runtimeForContext).not.toHaveBeenCalled();
    expect(await t.read()).toMatchObject({
      phase: "error",
      checkpoint: t.evidence,
    });
  });
});
