// The production admission/quotas around a controlled asynchronous transport.
import { LimitedWorkerCommandBus } from "../../cantrip_server/src/workers/limited-command-bus.ts";
import { RelayQuotaManager } from "../../cantrip_server/src/operations/relay-quotas.ts";
import { RelayLimitError } from "../../cantrip_server/src/security/abuse-limits.ts";
import { WorkerUnavailableError } from "../../cantrip_server/src/workers/bridge.ts";
let now = 0;
const originalNow = Date.now;
Date.now = () => now;
const tick = () => new Promise((resolve) => setImmediate(resolve));
const limits = {
  accountConcurrency: 2,
  accountRatePerMinute: 100,
  workerConcurrency: 1,
  workerRatePerMinute: 100,
};
const quotaLimits = [1000000, 1000000, 1000000, 1000000, 2, 1];
const start = (id, worker = "w0", extra = {}) => ({
  op: "start",
  id,
  worker,
  ...extra,
});
const reply = (id, extra = {}) => ({ op: "reply", id, ...extra });
const scenarios = [
  {
    name: "raw-worker-references-keep-independent-worker-budgets",
    limits: { ...limits, accountRatePerMinute: 4, workerRatePerMinute: 1 },
    steps: [
      start("array-a", ["w0"]),
      start("array-b", ["w0"]),
      start("normal", "w0"),
      start("array-c", ["w0"]),
      reply("normal"),
      start("account-rate", "w1"),
    ],
  },
  {
    name: "concurrency-and-release",
    steps: [
      start("a"),
      start("b"),
      start("c", "w1"),
      start("d", "w2"),
      reply("a", { value: null }),
      start("e"),
      reply("c", { value: { accepted: true } }),
      reply("e"),
      reply("d"),
    ],
  },
  {
    name: "account-rate-after-active-rejection",
    limits: { ...limits, accountConcurrency: 1, accountRatePerMinute: 2 },
    steps: [
      start("a", "w0", { timeout: null }),
      start("b", "w1"),
      reply("a"),
      start("c"),
      { op: "clock", now: 60000 },
      start("d"),
      reply("d"),
    ],
  },
  {
    name: "worker-rate-is-independent",
    limits: { ...limits, workerRatePerMinute: 1 },
    steps: [
      start("a"),
      reply("a"),
      start("b"),
      start("c", "w1"),
      reply("c"),
      { op: "clock", now: 60001 },
      start("d"),
      reply("d"),
    ],
  },
  {
    name: "owner-cache-and-failures",
    steps: [
      start("missing", "missing"),
      start("lookup", "lookup"),
      start("a"),
      reply("a"),
      { op: "owners", owners: { w0: "other" } },
      start("b"),
      reply("b"),
      start("c", "w2"),
      reply("c"),
    ],
  },
  {
    name: "unobserved-caller-retains-active-claim",
    limits: { ...limits, accountConcurrency: 1 },
    steps: [
      start("a"),
      { op: "drop", id: "a" },
      start("b", "w1"),
      reply("a", { value: { accepted: true } }),
      start("c", "w1"),
      reply("c"),
    ],
  },
  {
    name: "event-and-response-accounting",
    steps: [
      start("a", "w0", { events: "accept", timeout: 120000 }),
      { op: "event", id: "a", value: { opaque: "🦀\ud800", sequence: 1 } },
      reply("a", { value: null }),
      start("b"),
      { op: "event", id: "b", value: { ignored: "no observer" } },
      reply("b"),
      start("c", "w1", { events: "reject" }),
      { op: "event", id: "c", value: { opaque: "event" } },
      start("d", "w1"),
      reply("d"),
    ],
  },
  {
    name: "response-quota-and-retry",
    quotaLimits: [160, 1000, 1000, 1000, 2, 1],
    steps: [
      start("a"),
      reply("a", { value: "x".repeat(200) }),
      start("b"),
      reply("b"),
      start("c"),
      reply("c"),
      { op: "clock", now: 60001 },
      start("d"),
      reply("d", { value: null }),
    ],
  },
  {
    name: "event-quota-rejects-before-observer",
    quotaLimits: [160, 1000, 1000, 1000, 2, 1],
    steps: [
      start("a", "w0", { events: "accept" }),
      { op: "event", id: "a", value: "x".repeat(200) },
      start("b"),
      reply("b"),
    ],
  },
  {
    name: "request-quota-before-rate",
    limits: { ...limits, accountRatePerMinute: 1 },
    quotaLimits: [100, 1000, 1000, 1000, 2, 1],
    steps: [
      start("a", "w0", {
        command: { type: "worker.version", opaque: "x".repeat(150) },
      }),
      start("b"),
      reply("b"),
    ],
  },
  {
    name: "shutdown-and-offline-delegate",
    steps: [
      start("a"),
      start("b", "w1"),
      { op: "close" },
      start("c"),
      start("d", "missing"),
    ],
  },
];
function failure(error) {
  if (error instanceof RelayLimitError)
    return {
      kind: "limit",
      message: error.message,
      retryAfterSeconds: error.retryAfterSeconds,
    };
  return {
    kind: error instanceof WorkerUnavailableError ? "unavailable" : "error",
    message: error.message,
  };
}
async function run(input) {
  now = 0;
  const owners = { w0: "owner", w1: "owner", w2: "other", lookup: "!error" },
    lookups = [],
    calls = [],
    pending = new Map(),
    observed = new Map(),
    promises = new Map(),
    events = [];
  let closed = false;
  const q = input.quotaLimits ?? quotaLimits;
  const quotas = new RelayQuotaManager({
    accountRelayBytesPerMinute: q[0],
    workerRelayBytesPerMinute: q[1],
    accountUploadBytesPerMinute: q[2],
    workerUploadBytesPerMinute: q[3],
    accountRemoteSurfaceLimit: q[4],
    workerRemoteSurfaceLimit: q[5],
  });
  const delegate = {
    stats: () => ({ connectedWorkers: closed ? 0 : 3 }),
    request(worker, command, options) {
      if (typeof worker !== "string")
        return Promise.reject(
          new WorkerUnavailableError(`Worker ${worker} is offline.`),
        );
      calls.push({
        worker,
        owner: options.ownerId,
        command,
        deadlineMs:
          options.timeoutMs === null ? null : (options.timeoutMs ?? 600000),
      });
      if (closed)
        return Promise.reject(
          new WorkerUnavailableError(`Worker ${worker} is offline.`),
        );
      return new Promise((resolve, reject) =>
        pending.set(command.fixtureRequestId, { resolve, reject, options }),
      );
    },
  };
  const bus = new LimitedWorkerCommandBus(delegate, {
    ...(input.limits ?? limits),
    consumeRelayBytes: (owner, worker, bytes) =>
      quotas.consumeRelay(owner, worker, bytes),
    resolveOwnerId: async (worker) => {
      lookups.push(String(worker));
      if (owners[worker] === "!error")
        throw new Error("Controlled owner lookup failure.");
      return owners[worker] ?? null;
    },
  });
  const snapshots = [];
  for (const step of [...input.steps, { op: "close" }]) {
    let action = { ok: true };
    if (step.op === "clock") now = step.now;
    else if (step.op === "owners") Object.assign(owners, step.owners);
    else if (step.op === "start") {
      observed.set(step.id, { pending: true });
      const options = {
        ...(Object.hasOwn(step, "timeout") ? { timeoutMs: step.timeout } : {}),
        ...(step.events
          ? {
              onEvent: async (event) => {
                events.push({ id: step.id, event });
                if (step.events === "reject")
                  throw new Error("Controlled callback failure 🦀\ud800");
              },
            }
          : {}),
      };
      const promise = bus
        .request(
          step.worker,
          {
            ...(step.command ?? { type: "worker.version" }),
            fixtureRequestId: step.id,
          },
          options,
        )
        .then(
          (value) => {
            if (observed.get(step.id)?.unobserved !== true)
              observed.set(step.id, {
                ok: true,
                ...(value === undefined ? {} : { value }),
              });
          },
          (error) => {
            if (observed.get(step.id)?.unobserved !== true)
              observed.set(step.id, { error: failure(error) });
          },
        );
      promises.set(step.id, promise);
      await tick();
    } else if (step.op === "drop") {
      observed.set(step.id, { unobserved: true });
    } else if (step.op === "reply") {
      const request = pending.get(step.id);
      action = { delivered: Boolean(request) };
      if (request) {
        pending.delete(step.id);
        request.resolve(step.value);
        await promises.get(step.id);
      }
    } else if (step.op === "event") {
      const request = pending.get(step.id);
      action = { delivered: Boolean(request) };
      if (request?.options.onEvent)
        try {
          await request.options.onEvent(step.value);
        } catch (error) {
          pending.delete(step.id);
          request.reject(error);
          await promises.get(step.id);
        }
    } else if (step.op === "close") {
      closed = true;
      for (const request of pending.values())
        request.reject(new WorkerUnavailableError("Server is shutting down."));
      pending.clear();
      await Promise.all(promises.values());
    }
    await tick();
    snapshots.push(
      structuredClone({
        action,
        outcomes: Object.fromEntries(observed),
        calls,
        lookups,
        events,
        stats: bus.stats(),
        quotas: quotas.stats(),
      }),
    );
  }
  return snapshots;
}
try {
  const results = [];
  for (const scenario of scenarios)
    results.push({
      input: { limits, quotaLimits, ...scenario },
      expected: await run(scenario),
    });
  process.stdout.write(
    "ORACLE_RESULT " +
      JSON.stringify({ done: results.length, scenarios: results }) +
      "\n",
  );
} finally {
  Date.now = originalNow;
}
