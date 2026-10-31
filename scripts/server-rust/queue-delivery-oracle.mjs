import assert from "node:assert/strict";
import { createManagedQueueDelivery } from "../../cantrip_server/src/app/runtime/managed-queue-delivery.ts";
import { cases } from "./queue-delivery-cases.mjs";
const settle = () => new Promise(setImmediate);
const originalSetInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
async function run(input) {
  const trace = [],
    pending = [],
    runs = new Map(),
    observations = [],
    timers = new Map(),
    counts = new Map();
  let now = 0,
    timerId = 0;
  const issue = (kind, args = {}) => {
    const index = counts.get(kind) ?? 0;
    counts.set(kind, index + 1);
    trace.push({ kind, index, ...args });
    return new Promise((resolve, reject) =>
      pending.push({
        kind,
        index,
        chat: args.chatId,
        resolve,
        reject,
        done: false,
      }),
    );
  };
  globalThis.setInterval = (callback, ms) => {
    assert.equal(ms, 1000, "Source delivery interval");
    const timer = { id: ++timerId, at: now + ms, ms, callback, unref() {} };
    timers.set(timer.id, timer);
    return timer;
  };
  globalThis.clearInterval = (timer) => timers.delete(timer.id);
  const service = createManagedQueueDelivery({
    repository: {
      pendingDispatches: () => issue("dispatches"),
      pendingNotifications: () => issue("notifications"),
      acknowledgeNotification: (chatId, revision) =>
        issue("acknowledge", { chatId, revision }),
      deferNotification: (chatId) => issue("defer", { chatId }),
    },
    bridge: {
      request: (workerId, command, options) =>
        issue("request", {
          chatId: command.chatId,
          workerId,
          command,
          options,
        }),
    },
    publish: (ownerId, chatId) => {
      trace.push({ kind: "publish", ownerId, chatId });
      if (input.stopOnPublish) service.stop();
      if (input.publishErrors?.[chatId])
        throw new Error(input.publishErrors[chatId]);
    },
    onError: (error) => trace.push({ kind: "error", message: error.message }),
    dispatch:
      input.dispatch === false
        ? undefined
        : (ownerId, chatId) => issue("dispatch", { ownerId, chatId }),
  });
  try {
    for (const step of input.steps) {
      if (step.op === "run") {
        const future = service.runOnce();
        const coalescedWith =
          [...runs].find(([, v]) => v === future)?.[0] ?? null;
        runs.set(step.id, future);
        trace.push({ kind: "run", id: step.id, coalescedWith });
      } else if (step.op === "complete") {
        const call = pending.find(
          (p) =>
            !p.done &&
            p.kind === step.kind &&
            (step.chat === undefined || p.chat === step.chat),
        );
        assert.ok(
          call,
          `${input.name}: missing pending ${step.kind} ${step.chat ?? ""}`,
        );
        call.done = true;
        if (step.error) call.reject(new Error(step.error));
        else call.resolve(step.value);
      } else if (step.op === "wait") {
        let complete = false;
        void runs.get(step.id).then(() => (complete = true));
        await settle();
        assert.equal(complete, true, `${input.name}: sweep did not settle`);
        trace.push({ kind: "settled", id: step.id });
      } else if (step.op === "observe")
        observations.push({ name: step.name, trace: structuredClone(trace) });
      else if (step.op === "stop") service.stop();
      else if (step.op === "start") service.start();
      else if (step.op === "advance") {
        const until = now + step.ms;
        for (;;) {
          const next = [...timers.values()]
            .filter((t) => t.at <= until)
            .sort((a, b) => a.at - b.at)[0];
          if (!next) break;
          now = next.at;
          next.at += next.ms;
          next.callback();
          await settle();
        }
        now = until;
      } else throw new Error("Unknown delivery scenario step");
      await settle();
    }
    assert.equal(
      pending.filter((p) => !p.done).length,
      0,
      `${input.name}: no abandoned operations`,
    );
    assert.equal(timers.size, 0, `${input.name}: no retained timer`);
    return { trace, observations };
  } finally {
    service.stop();
    globalThis.setInterval = originalSetInterval;
    globalThis.clearInterval = originalClearInterval;
  }
}
for (const input of cases) input.expected = await run(input);
console.log(JSON.stringify(cases));
