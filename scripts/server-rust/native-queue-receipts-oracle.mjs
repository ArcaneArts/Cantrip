// Execute the unchanged receipt waiter with controlled reads and timer delivery.
import assert from "node:assert/strict";
import {
  waitForManagedQueueReceipt,
  notifyManagedQueueReceipt,
} from "../../cantrip_server/src/app/runtime/managed-queue-receipts.ts";
const start = (id = "a", extra = {}) => ({ op: "start", id, ...extra });
const reply = (index, value, id = "a") => ({ op: "reply", id, index, value });
const notice = (chat = "chat") => ({ op: "notify", chat });
const wait = (id = "a") => ({ op: "wait", id });
const observe = (name) => ({ op: "observe", name });
const advance = (ms) => ({ op: "advance", ms });
const abort = (reason = "disconnected", id = "a") => ({
  op: "abort",
  id,
  reason,
});
const receipt = { receipt: { status: "applied" }, resultDigest: "verified" };
const cases = [
  {
    name: "already aborted never reads",
    steps: [
      start("a", { aborted: "already aborted" }),
      wait(),
      notice(),
      observe("cleaned"),
    ],
  },
  {
    name: "immediate receipt",
    steps: [start(), reply(0, receipt), wait(), notice(), observe("cleaned")],
  },
  {
    name: "query rejection is retained",
    steps: [
      start(),
      { op: "reject", id: "a", index: 0, error: "query failed" },
      wait(),
      notice(),
      observe("cleaned"),
    ],
  },
  {
    name: "notice during a read causes an immediate reread",
    steps: [
      start(),
      notice(),
      reply(0, null),
      observe("reread"),
      reply(1, receipt),
      wait(),
    ],
  },
  {
    name: "lost notice polls at exactly 750 milliseconds",
    steps: [
      start(),
      reply(0, null),
      advance(749),
      observe("before deadline"),
      advance(1),
      observe("at deadline"),
      reply(1, receipt),
      wait(),
    ],
  },
  {
    name: "notice while waiting clears the old poll timer",
    steps: [
      start(),
      reply(0, null),
      notice(),
      observe("reread"),
      reply(1, receipt),
      wait(),
      advance(750),
      observe("cleaned"),
    ],
  },
  {
    name: "completed read wins over concurrent abort",
    steps: [start(), abort(), reply(0, receipt), wait()],
  },
  {
    name: "empty read observes concurrent abort",
    steps: [start(), abort(), reply(0, null), wait()],
  },
  {
    name: "abort while waiting removes its timer",
    steps: [
      start(),
      reply(0, null),
      abort(),
      wait(),
      advance(750),
      notice(),
      observe("cleaned"),
    ],
  },
  {
    name: "one notice wakes every waiter on that Chat",
    steps: [
      start(),
      start("b"),
      reply(0, null),
      reply(0, null, "b"),
      notice(),
      observe("both reread"),
      reply(1, receipt),
      reply(1, receipt, "b"),
      wait(),
      wait("b"),
      advance(750),
      observe("cleaned"),
    ],
  },
  {
    name: "repeated notices during a read coalesce",
    steps: [
      start(),
      notice(),
      notice(),
      notice(),
      reply(0, null),
      observe("one reread"),
      reply(1, receipt),
      wait(),
    ],
  },
  ...["__proto__", "\ud800", "\udc00", "😀"].map((chat) => ({
    name: "original UTF16 Chat key " + JSON.stringify(chat),
    steps: [
      start("a", { chat }),
      notice("�"),
      reply(0, null),
      observe("unrelated notice ignored"),
      notice(chat),
      observe("original key notified"),
      reply(1, receipt),
      wait(),
    ],
  })),
];
const settle = () => new Promise(setImmediate);
const originalSetTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
async function run(input) {
  const timers = new Map(),
    reads = new Map(),
    calls = [],
    results = [],
    observations = [];
  let now = 0,
    nextTimer = 0;
  globalThis.setTimeout = (callback, ms) => {
    assert.equal(ms, 750, "the actual Source waiter poll interval");
    const id = ++nextTimer;
    timers.set(id, { callback, at: now + ms });
    return id;
  };
  globalThis.clearTimeout = (id) => timers.delete(id);
  try {
    for (const step of input.steps) {
      if (step.op === "start") {
        const controller = new AbortController(),
          pending = [];
        if (step.aborted) controller.abort(new Error(step.aborted));
        const read = waitForManagedQueueReceipt(
          {
            managedQueue: {
              startReceipt(owner, worker, session, claim) {
                assert.equal(owner, "owner");
                assert.equal(worker, "worker");
                assert.equal(claim, "claim");
                assert.equal(session.chatId, step.chat ?? "chat");
                calls.push({ id: step.id, index: pending.length });
                return new Promise((resolve, reject) =>
                  pending.push({ resolve, reject }),
                );
              },
            },
          },
          "owner",
          "worker",
          { chatId: step.chat ?? "chat" },
          "claim",
          controller.signal,
        );
        reads.set(step.id, {
          controller,
          pending,
          result: read.then(
            (ok) => ({ ok }),
            (error) => ({ error: error.message }),
          ),
        });
      } else if (step.op === "reply") {
        reads.get(step.id).pending[step.index].resolve(step.value);
      } else if (step.op === "reject") {
        reads.get(step.id).pending[step.index].reject(new Error(step.error));
      } else if (step.op === "notify") {
        notifyManagedQueueReceipt(step.chat);
      } else if (step.op === "abort") {
        reads.get(step.id).controller.abort(new Error(step.reason));
      } else if (step.op === "advance") {
        const until = now + step.ms;
        for (;;) {
          const due = [...timers.entries()]
            .filter(([, value]) => value.at <= until)
            .sort((a, b) => a[1].at - b[1].at)[0];
          if (!due) break;
          now = due[1].at;
          timers.delete(due[0]);
          due[1].callback();
          await settle();
        }
        now = until;
      } else if (step.op === "wait") {
        results.push({ id: step.id, ...(await reads.get(step.id).result) });
      } else if (step.op === "observe") {
        observations.push({ name: step.name, calls: structuredClone(calls) });
      } else throw new Error("Unknown receipt oracle step");
      await settle();
    }
    assert.equal(timers.size, 0, "finished waiters remove polling timers");
    return { calls, results, observations };
  } finally {
    globalThis.setTimeout = originalSetTimeout;
    globalThis.clearTimeout = originalClearTimeout;
  }
}
for (const input of cases) input.expected = await run(input);
console.log(JSON.stringify(cases));
