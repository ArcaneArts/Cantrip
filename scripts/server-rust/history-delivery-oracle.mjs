// Pure scheduling evidence from the unchanged production history service.
// Actual publication SQL, transport and encrypted archives use the HTTP suite.
import assert from "node:assert/strict";
import { createNativeHistoryPublicationDelivery } from "../../cantrip_server/src/app/runtime/native-history-publication-delivery.ts";
import { cases as completionCases } from "./completion-delivery-cases.mjs";
function publication(value) {
  if (Array.isArray(value)) return value.map(publication);
  if (!value || typeof value !== "object") return value;
  if (value.rootOperationId)
    return {
      ownerId: value.ownerId,
      workerId: value.workerId,
      chatId: value.chatId,
      bindingId: "binding-" + value.rootOperationGeneration,
      commitId: value.rootOperationId,
      attempts: value.attempts,
    };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      key === "kind" && item === "request" ? "publish" : publication(item),
    ]),
  );
}
const cases = completionCases.flatMap((original) => {
  const input = publication(original);
  input.name = input.name
    .replaceAll("worker", "publication")
    .replaceAll("root", "commit");
  input.publication = true;
  return [
    input,
    {
      ...structuredClone(input),
      name: input.name + "; failing diagnostics suppressed",
      throwOnError: true,
    },
  ];
});
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
        root: args.entry?.commitId,
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
  const service = createNativeHistoryPublicationDelivery({
    repository: {
      listPending: (limit) => issue("list", { limit }),
      acknowledge: (entry) => issue("ack", { entry }),
      defer: (entry, at) => issue("defer", { entry, at: at.getTime() }),
    },
    publish: (entry) => issue("publish", { entry }),
    onError: (error, entry) => {
      trace.push({
        kind: "error",
        message: error.message,
        entry: entry ?? null,
      });
      if (input.clockOnError) now = input.clockOnError;
      if (input.stopOnError) service.stop();
      if (input.throwOnError) throw new Error("controlled diagnostic failure");
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
      } else throw new Error("Unknown publication delivery step");
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
