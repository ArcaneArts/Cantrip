import assert from "node:assert/strict";
import { createNativeLogicalCompletionDelivery } from "../../cantrip_server/src/app/runtime/native-logical-completion-delivery.ts";
import { cases } from "./completion-delivery-cases.mjs";
const settle = () => new Promise(setImmediate);
const originalNow = Date.now,
  originalTimeout = globalThis.setTimeout,
  originalClear = globalThis.clearTimeout;
async function run(input) {
  const trace = [],
    observations = [],
    pending = [],
    counts = new Map(),
    runs = new Map(),
    timers = new Map();
  let now = 1700000000000,
    nextTimer = 0;
  const issue = (kind, args = {}) => {
    const index = counts.get(kind) ?? 0;
    counts.set(kind, index + 1);
    trace.push({ kind, index, ...args });
    return new Promise((resolve, reject) =>
      pending.push({
        kind,
        root: args.command?.rootOperationId ?? args.identity?.[3],
        resolve,
        reject,
        done: false,
      }),
    );
  };
  Date.now = () => now;
  globalThis.setTimeout = (callback, ms) => {
    assert.equal(ms, input.intervalMs ?? 1000);
    const timer = { id: ++nextTimer, at: now + ms, callback, unref() {} };
    timers.set(timer.id, timer);
    return timer;
  };
  globalThis.clearTimeout = (timer) => timers.delete(timer.id);
  const service = createNativeLogicalCompletionDelivery({
    repository: {
      listPendingLogicalCompletions: (limit) => issue("list", { limit }),
      acknowledgeLogicalCompletion: (...identity) => issue("ack", { identity }),
      deferLogicalCompletion: (...args) => {
        const at = args.pop();
        return issue("defer", { identity: args, at: at.getTime() });
      },
    },
    bridge: {
      request: (workerId, command, options) =>
        issue("request", { workerId, command, options }),
    },
    onError: (error, entry) => {
      trace.push({
        kind: "error",
        message: error.message,
        entry: entry ?? null,
      });
      if (input.clockOnError) now = input.clockOnError;
      if (input.stopOnError) service.stop();
    },
    intervalMs: input.intervalMs,
  });
  try {
    for (const step of input.steps) {
      if (step.op === "run") {
        const future = service.runOnce(),
          coalescedWith = [...runs].find(([, p]) => p === future)?.[0] ?? null;
        runs.set(step.id, future);
        trace.push({ kind: "run", id: step.id, coalescedWith });
      } else if (step.op === "complete") {
        const p = pending.find(
          (p) =>
            !p.done &&
            p.kind === step.kind &&
            (step.root === undefined || p.root === step.root),
        );
        assert.ok(p, `${input.name}: missing ${step.kind} ${step.root ?? ""}`);
        p.done = true;
        if (step.error) p.reject(new Error(step.error));
        else p.resolve(step.value);
      } else if (step.op === "wait") {
        let ready = false;
        void runs.get(step.id).then(() => (ready = true));
        await settle();
        assert.equal(ready, true, `${input.name}: sweep did not settle`);
        trace.push({ kind: "settled", id: step.id });
      } else if (step.op === "drop") runs.delete(step.id);
      else if (step.op === "start") service.start();
      else if (step.op === "stop") service.stop();
      else if (step.op === "observe")
        observations.push({ name: step.name, trace: structuredClone(trace) });
      else if (step.op === "advance") {
        const until = now + step.ms;
        for (;;) {
          const due = [...timers.values()]
            .filter((t) => t.at <= until)
            .sort((a, b) => a.at - b.at)[0];
          if (!due) break;
          now = due.at;
          timers.delete(due.id);
          due.callback();
          await settle();
        }
        now = until;
      } else throw new Error("Unknown completion delivery step");
      await settle();
    }
    assert.equal(
      pending.filter((p) => !p.done).length,
      0,
      `${input.name}: unfinished operation`,
    );
    assert.equal(timers.size, 0, `${input.name}: no retained timer`);
    return { trace, observations };
  } finally {
    service.stop();
    Date.now = originalNow;
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClear;
  }
}
for (const input of cases) input.expected = await run(input);
console.log(JSON.stringify(cases));
