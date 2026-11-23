import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CodexInferenceAdmission } from "../src/codex/inference-admission.js";
import { WorkerInferenceAdmission } from "../src/inference-admission.js";
import type {
  InferenceJournalCommand,
  InferenceJournalMutation,
  InferenceJournalRecord,
} from "../src/inference-journal.js";
import type { NativeInferenceOwnership } from "../src/native-inference-ownership.js";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

async function fixture() {
  const generation = randomUUID();
  const errors: unknown[] = [];
  const records = new Map<string, InferenceJournalRecord>();
  const writes: string[] = [];
  let revision = 0;
  let intercept = async (_command: InferenceJournalMutation) => {};
  async function mutate(command: InferenceJournalMutation) {
    await intercept(command);
    writes.push(command.action);
    const previous = records.get(command.key);
    let record: InferenceJournalRecord;
    if (command.action === "enqueue") {
      record = {
        key: command.key,
        identity: command.identity,
        workerGeneration: generation,
        state: "waiting",
        order: ++revision,
        revision,
        everGranted: false,
        outcome: null,
      };
    } else {
      if (!previous) throw new Error("Missing fixture journal record");
      record = { ...previous, revision: ++revision };
      if (command.action === "grant") {
        record.state = "granted";
        record.everGranted = true;
      } else if (command.action === "release") {
        record.state = "released";
        record.outcome = command.outcome;
      } else if (command.action === "requeue") {
        record.state = "waiting";
        record.outcome = null;
        record.order = revision;
      } else throw new Error("Unexpected fixture journal mutation");
    }
    records.set(command.key, record);
    return record;
  }
  const ownership: NativeInferenceOwnership = {
    available: true,
    onLost() {},
    async prepare() {
      return {};
    },
    async retire() {},
    async close() {},
    async journal(command: InferenceJournalCommand) {
      if (command.action === "snapshot")
        return {
          version: 1,
          revision,
          operations: Object.fromEntries(records),
        };
      if (command.action !== "batch")
        throw new Error("Unexpected fixture journal command");
      return Promise.all(
        command.commands.map(async (mutation) => ({
          ok: true,
          result: await mutate(mutation),
        })),
      );
    },
  };
  const admission = new WorkerInferenceAdmission(
    {
      serverId: "server",
      ownerId: "owner",
      workerId: "worker",
      workerGeneration: generation,
    },
    (error) => errors.push(error),
    ownership,
  );
  admission.configure({ providerId: "provider", maxConcurrentInference: 1 });
  const runtime = admission.createRuntime();
  await runtime.prepareNativeLaunch();
  function request(operationId = randomUUID()) {
    return runtime.request({
      operationId,
      lifetime: runtime.createOperationLifetime(operationId),
      providerId: "provider",
      chatId: "chat",
    });
  }
  return {
    admission,
    request,
    errors,
    records,
    writes,
    intercept(fn: typeof intercept) {
      intercept = fn;
    },
  };
}

describe("Pause before native input dispatch", () => {
  it("parks only an explicitly owned unused grant and requires fresh permission", async () => {
    const f = await fixture();
    try {
      const input = f.request();
      const original = input.ready;
      await original;
      expect(input.pauseWaiting()).toBe(false);
      expect(input.pauseWaiting(true)).toBe(true);
      await input.confirmPause();
      expect(input.ready).not.toBe(original);
      expect(f.admission.snapshot().pools[0]!.activeCount).toBe(0);
      const competitor = f.request();
      const competitorLease = await competitor.ready;
      let forwarded = false;
      void input.ready.then(() => (forwarded = true));
      input.resumeWaiting();
      await Promise.resolve();
      expect(input.status().state).toBe("waiting");
      expect(forwarded).toBe(false);
      competitorLease.settle("never-started");
      const resumed = await input.ready;
      expect(input.status().state).toBe("granted");
      resumed.start();
      expect(input.pauseWaiting(true)).toBe(false);
      resumed.settle("completed");
      expect(f.errors).toEqual([]);
    } finally {
      await f.admission.close();
    }
  });

  it("cannot resolve a parked acquisition from a late grant reply", async () => {
    const f = await fixture();
    const entered = deferred();
    const reply = deferred();
    f.intercept(async (command) => {
      if (command.action === "grant") {
        entered.resolve();
        await reply.promise;
      }
    });
    try {
      const input = f.request();
      await entered.promise;
      expect(input.pauseWaiting(true)).toBe(true);
      const paused = input.confirmPause();
      reply.resolve();
      await paused;
      let acquired = false;
      void input.ready.then(() => (acquired = true));
      await Promise.resolve();
      expect(acquired).toBe(false);
      expect(input.status().state).toBe("suspended");
      input.resumeWaiting();
      (await input.ready).settle("never-started");
      expect(f.errors).toEqual([]);
    } finally {
      reply.resolve();
      await f.admission.close();
    }
  });

  it("does not reuse no-start evidence after the grant has run", async () => {
    const f = await fixture();
    try {
      const input = f.request();
      await input.ready;
      input.pauseWaiting(true);
      await input.confirmPause();
      input.resumeWaiting();
      const lease = await input.ready;
      lease.start();
      lease.suspend();
      const competitor = f.request();
      const other = await competitor.ready;
      const resuming = lease.resume();
      expect(input.status().state).toBe("waiting");
      input.pauseWaiting();
      await input.confirmPause();
      expect(f.writes.filter((action) => action === "release")).toHaveLength(1);
      input.resumeWaiting();
      other.settle("never-started");
      await resuming;
      lease.settle("completed");
      expect(f.errors).toEqual([]);
    } finally {
      await f.admission.close();
    }
  });

  it("propagates the actual pause write failure through its acknowledgement", async () => {
    const f = await fixture();
    try {
      const input = f.request();
      await input.ready;
      const failure = new Error("Synthetic fsync failure");
      f.intercept(async (command) => {
        if (command.action === "release") throw failure;
      });
      expect(input.pauseWaiting(true)).toBe(true);
      await expect(input.confirmPause()).rejects.toThrow(
        "Synthetic fsync failure",
      );
      expect(f.errors).toContain(failure);
      f.intercept(async () => {});
      expect(input.pauseWaiting(true)).toBe(true);
      await input.confirmPause();
      expect([...f.records.values()][0]!.outcome).toBe("never-started");
    } finally {
      f.intercept(async () => {});
      await f.admission.close();
    }
  });

  it("commits a newer Pause after an in-flight Resume requeue", async () => {
    const f = await fixture();
    const entered = deferred();
    const reply = deferred();
    try {
      const input = f.request();
      await input.ready;
      input.pauseWaiting(true);
      await input.confirmPause();
      f.intercept(async (command) => {
        if (command.action === "requeue") {
          entered.resolve();
          await reply.promise;
        }
      });
      input.resumeWaiting();
      await entered.promise;
      input.pauseWaiting(true);
      const pausedAgain = input.confirmPause();
      reply.resolve();
      await pausedAgain;
      expect(f.writes).toEqual([
        "enqueue",
        "grant",
        "release",
        "requeue",
        "release",
      ]);
      expect([...f.records.values()][0]).toMatchObject({
        state: "released",
        outcome: "never-started",
      });
      expect(input.status().state).toBe("suspended");
      expect(f.admission.snapshot().pools[0]!.activeCount).toBe(0);
      expect(f.errors).toEqual([]);
    } finally {
      reply.resolve();
      await f.admission.close();
    }
  });

  it("blocks canonical dispatch until Resume and refuses a hold after dispatch begins", async () => {
    const f = await fixture();
    const native = new CodexInferenceAdmission(f.admission);
    await native.prepareNativeLaunch();
    const released = deferred();
    const operationId = randomUUID();
    try {
      expect(native.canHoldUnstartedChat("chat", true)).toBe(false);
      const execution = await native.acquire({
        operationId,
        lifetime: native.lifetimeForSource({
          operationId,
          nativeTransportGeneration: null,
          released: released.promise,
          assertCurrent() {},
        }),
        purpose: "turn",
        provider: { id: "provider" },
        chatId: "chat",
      });
      native.setChatPaused("chat", true);
      await native.confirmChatHold("chat");
      let dispatched = false;
      const dispatch = execution.sealInputDispatch().then(() => {
        dispatched = true;
      });
      await Promise.resolve();
      expect(dispatched).toBe(false);
      expect(native.canHoldUnstartedChat("chat", true)).toBe(true);
      native.setChatPaused("chat", false);
      await dispatch;
      expect(dispatched).toBe(true);
      expect(native.canHoldUnstartedChat("chat", true)).toBe(false);
      execution.notDispatched();
      await execution.settled();
    } finally {
      released.resolve();
      await f.admission.close();
    }
  });

  it("keeps later same-provider preparation behind the parked permission", async () => {
    const f = await fixture();
    const native = new CodexInferenceAdmission(f.admission);
    await native.prepareNativeLaunch();
    const released = deferred();
    const operationId = randomUUID();
    try {
      const execution = await native.acquire({
        operationId,
        lifetime: native.lifetimeForSource({
          operationId,
          nativeTransportGeneration: null,
          released: released.promise,
          assertCurrent() {},
        }),
        purpose: "turn",
        provider: { id: "provider" },
        chatId: "chat",
      });
      native.setChatPaused("chat", true);
      await native.confirmChatHold("chat");
      let invoked = false;
      const preparation = execution.prepare("provider", async (scope) => {
        invoked = true;
        scope.beforeSend();
        scope.replied();
        return "prepared";
      });
      void preparation.catch(() => {});
      await Promise.resolve();
      expect(invoked).toBe(false);
      native.setChatPaused("chat", false);
      await expect(preparation).resolves.toBe("prepared");
      execution.notDispatched();
      await execution.settled();
    } finally {
      released.resolve();
      await f.admission.close();
    }
  });
});
