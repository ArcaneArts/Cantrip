// Actual reference bridge/deadline/logger, with deterministic socket and clock IO.
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { performance } from "node:perf_hooks";
import {
  WorkerBridge,
  WorkerUnavailableError,
} from "../../cantrip_server/src/workers/bridge.ts";
import {
  createServiceLogger,
  minimizeServiceLogRecordInput,
} from "../../packages/logging/dist/index.js";

const command = {
  type: "worker.credential.rotate",
  credential: "ctwk_" + "A".repeat(43),
};
const attach = (socket = "s1", extra = {}) => ({
  op: "attach",
  socket,
  ...extra,
});
const request = (name = "r1", extra = {}) => ({
  op: "request",
  name,
  command,
  timeoutMs: 100,
  ...extra,
});
const response = (name = "r1", extra = {}) => ({
  op: "response",
  name,
  ...extra,
});
const event = (name = "r1", sequence = 0, state = "preparing") => ({
  op: "event",
  name,
  event: { type: "inference.command-state", sequence, state, admitted: true },
});
const clock = (ms, extra = {}) => ({ op: "advance", ms, ...extra });
const close = { op: "close" };
const cases = [
  {
    name: "encoding-does-not-consume-wire-sequence",
    steps: [
      attach(),
      request("invalid", {
        command: { type: "worker.credential.rotate", credential: "invalid" },
      }),
      request(),
      response(),
    ],
  },
  {
    name: "success-worker-errors-and-absent-result",
    steps: [
      attach(),
      request(),
      clock(7),
      response(),
      request("r2"),
      response("r2", { ok: false, code: "worker-busy" }),
      request("r3"),
      response("r3", { ok: false }),
      request("r4"),
      response("r4", { ok: false, code: "" }),
      request("r5"),
      response("r5", { missing: true }),
      request("r6"),
      response("r6", { result: null }),
      clock(101),
    ],
  },
  {
    name: "offline-noise-and-key-isolation",
    steps: [
      ...Array.from({ length: 27 }, (_, i) => request("missing-" + i)),
      request("other", { worker: "other" }),
      request("missing-type", { command: {} }),
      clock(30000),
      request("window"),
    ],
  },
  {
    name: "invalid-envelope-noise-stale-peers-and-binary",
    steps: [
      attach(),
      ...Array.from({ length: 27 }, () => ({
        op: "invalid",
        socket: "s1",
        text: "{",
      })),
      { op: "invalid", socket: "s1", text: '{"kind":"unknown"}' },
      { op: "binary", socket: "s1" },
      attach("s2"),
      { op: "invalid", socket: "s1", text: "{" },
      { op: "binary", socket: "s1" },
      clock(30000),
      { op: "invalid", socket: "s2", text: "{" },
      { op: "binary", socket: "s2" },
    ],
  },
  {
    name: "reconnect-keeps-request-without-replay",
    steps: [
      attach(),
      request(),
      clock(5),
      { op: "interrupt", socket: "s1" },
      clock(9),
      attach("s2"),
      { ...response(), socket: "s1" },
      response(),
      clock(15001),
    ],
  },
  {
    name: "zero-wall-clock-reconnect-reference-truthiness",
    initial: 0,
    steps: [
      attach(),
      { op: "interrupt", socket: "s1" },
      clock(9),
      attach("s2"),
    ],
  },
  {
    name: "backward-wall-clock-duration-clamp",
    steps: [
      attach(),
      request(),
      clock(7, { wall: 1 }),
      response(),
      { op: "interrupt", socket: "s1" },
      clock(3, { wall: 0 }),
      attach("s2"),
    ],
  },
  {
    name: "continuity-change-abandons-before-callbacks",
    steps: [attach(), request(), attach("s2", { generation: "replacement" })],
  },
  {
    name: "interrupted-continuity-change",
    steps: [
      attach(),
      request(),
      { op: "interrupt", socket: "s1" },
      attach("s2", { credential: "replacement" }),
    ],
  },
  {
    name: "grace-expiry-aggregates-abandonment",
    grace: 15,
    steps: [
      attach(),
      request(),
      request("r2"),
      { op: "interrupt", socket: "s1" },
      clock(15),
      clock(101),
    ],
  },
  {
    name: "zero-grace-lifecycle-order",
    grace: 0,
    steps: [attach(), request(), { op: "interrupt", socket: "s1" }],
  },
  {
    name: "server-revocation-and-explicit-disconnect",
    steps: [
      attach(),
      request(),
      { op: "disconnect", code: 1008 },
      attach("s2"),
      request("r2"),
      { op: "disconnect", code: 1012 },
      { op: "disconnect", worker: "unknown", code: 1008 },
    ],
  },
  {
    name: "event-failure-before-response",
    steps: [
      attach(),
      request("r1", { handler: "fail" }),
      event(),
      clock(7),
      response(),
    ],
  },
  {
    name: "event-failure-after-response-captures-arrival-duration",
    steps: [
      attach(),
      request("r1", { handler: "hold-fail" }),
      event(),
      clock(7),
      response(),
      clock(101),
      { op: "release", name: "r1" },
    ],
  },
  {
    name: "ordered-held-events-clear-timeout-on-response",
    steps: [
      attach(),
      request("r1", { handler: "hold" }),
      event(),
      event("r1", 1),
      clock(7),
      response(),
      clock(101),
      { op: "release", name: "r1" },
    ],
  },
  {
    name: "deadline-waiting-and-timeout-ignore-late-response",
    steps: [
      attach(),
      request(),
      clock(40),
      event("r1", 0, "waiting"),
      clock(1000),
      event("r1", 1, "preparing"),
      clock(60),
      response(),
      clock(100),
    ],
  },
  {
    name: "send-failure-consumes-attempt-sequence",
    steps: [
      attach(),
      { op: "fail-send", socket: "s1" },
      request(),
      attach("s2"),
      request("r2"),
      response("r2"),
    ],
  },
  {
    name: "shutdown-keeps-worker-insertion-order",
    steps: [
      attach("s1", { worker: "first" }),
      attach("s2", { worker: "second" }),
      request("r1", { worker: "first" }),
      request("r2", { worker: "second" }),
      close,
      close,
    ],
  },
  {
    name: "shutdown-after-response-keeps-event-drain",
    steps: [
      attach(),
      request("r1", { handler: "hold" }),
      event(),
      response(),
      close,
      clock(101),
      { op: "release", name: "r1" },
    ],
  },
  {
    name: "legacy-continuity-is-not-invented",
    steps: [
      attach("s1", { legacy: true }),
      request(),
      attach("s2", { legacy: true, credential: "replacement" }),
      response(),
    ],
  },
];
cases.push(
  {
    name: "six-worker-shutdown-order",
    steps: [
      ...["first", "second", "third", "fourth", "fifth", "sixth"].flatMap(
        (worker, i) => [
          attach("s" + i, { worker }),
          request("r" + i, { worker }),
        ],
      ),
      close,
    ],
  },
  {
    name: "shutdown-orders-connected-before-interrupted-workers",
    steps: [
      attach("s0", { worker: "first" }),
      attach("s1", { worker: "second" }),
      attach("s2", { worker: "third" }),
      attach("s3", { worker: "fourth" }),
      { op: "interrupt", socket: "s2" },
      { op: "interrupt", socket: "s0" },
      close,
    ],
  },
  {
    name: "timeout-wins-held-event-failure",
    steps: [
      attach(),
      request("r1", { handler: "hold-fail", timeoutMs: 10 }),
      event(),
      clock(10),
      response(),
      { op: "release", name: "r1" },
      clock(100),
    ],
  },
  {
    name: "unbounded-command-deadline",
    steps: [
      attach(),
      request("r1", { timeoutMs: null }),
      clock(600001),
      response(),
    ],
  },
);
const original = {
  now: Date.now,
  timeout: globalThis.setTimeout,
  clear: globalThis.clearTimeout,
  performance: Object.getOwnPropertyDescriptor(performance, "now"),
};
const tick = async () => {
  for (let i = 0; i < 32; i++) await Promise.resolve();
};
try {
  for (const scenario of cases) {
    let wall = scenario.initial ?? 1793059200123,
      mono = 0,
      serial = 0,
      active = null;
    let records = [],
      trace = [];
    const timers = new Map(),
      aliases = new Map(),
      sockets = new Map(),
      requests = new Map(),
      gates = new Map(),
      outcomes = {},
      listeners = new Set();
    Date.now = () => wall;
    Object.defineProperty(performance, "now", {
      configurable: true,
      value: () => mono,
    });
    globalThis.setTimeout = (callback, ms) => {
      const timer = {
        id: ++serial,
        at: mono + Math.max(0, ms),
        callback,
        unref() {
          return this;
        },
      };
      timers.set(timer.id, timer);
      return timer;
    };
    globalThis.clearTimeout = (timer) => {
      if (timer) timers.delete(timer.id);
    };
    function alias(id) {
      if (id === undefined) return;
      assert.match(id, /^[0-9a-f-]{36}$/);
      if (!aliases.has(id)) {
        assert.ok(active, "request identity has an active origin");
        aliases.set(id, active);
      }
      return aliases.get(id);
    }
    function canonical(value) {
      return JSON.parse(
        JSON.stringify(value, (key, v) =>
          key === "requestId" && typeof v === "string" ? alias(v) : v,
        ),
      );
    }
    const logger = createServiceLogger("server", {
      now: () => new Date(wall),
      output: () => {},
      onRecord(record) {
        if (record.context?.requestId) alias(record.context.requestId);
        records.push(record);
        trace.push({ log: record.context?.event });
      },
    });
    const bridge = new WorkerBridge(scenario.grace ?? 15000, logger);
    class Socket extends EventEmitter {
      readyState = 1;
      bufferedAmount = 0;
      sent = [];
      fail = false;
      constructor(name, worker) {
        super();
        this.name = name;
        this.worker = worker;
      }
      publishReady() {
        this.send("ready");
        return true;
      }
      send(text) {
        if (this.fail) {
          this.readyState = 3;
          throw new Error("controlled-send-failure");
        }
        let value;
        try {
          value = JSON.parse(text);
        } catch {
          value = text;
        }
        if (value?.kind === "request") {
          alias(value.requestId);
          requests.get(active).id = value.requestId;
          requests.get(active).socket = this.name;
        }
        this.sent.push(
          value?.kind === "request"
            ? {
                packet: value,
                encoded: text.replace(value.requestId, alias(value.requestId)),
              }
            : value,
        );
      }
      close(code, reason) {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.sent.push({ close: code, reason });
        this.emit("close");
      }
    }
    const fail = (error, encoding = false) =>
      encoding
        ? { encoding: true }
        : {
            error: error.message,
            code: error.code ?? null,
            unavailable: error instanceof WorkerUnavailableError,
          };
    function snapshot() {
      const wire = {};
      for (const [name, socket] of sockets) {
        if (socket.sent.length) wire[name] = canonical(socket.sent.splice(0));
      }
      const current = records;
      records = [];
      const result = {
        stats: bridge.stats(),
        records: canonical(current),
        persisted: canonical(current.map(minimizeServiceLogRecordInput)),
        trace,
        wire,
        outcomes: structuredClone(outcomes),
      };
      trace = [];
      return result;
    }
    scenario.steps = [
      ...scenario.steps,
      ...(scenario.steps.at(-1)?.op === "close" ? [] : [close]),
    ];
    scenario.snapshots = [];
    for (const step of scenario.steps) {
      const worker = step.worker ?? "worker";
      if (step.op === "attach") {
        const socket = new Socket(step.socket, worker);
        sockets.set(step.socket, socket);
        if (!listeners.has(worker)) {
          listeners.add(worker);
          bridge.subscribeWorkerDisconnect(worker, () =>
            trace.push({ disconnect: worker }),
          );
          bridge.subscribeWorkerOffline(worker, () =>
            trace.push({ offline: worker }),
          );
        }
        const identity = {
          ownerId: "owner",
          credentialId: step.credential ?? "credential",
          workerProcessGeneration: step.generation ?? "process",
        };
        assert.equal(
          bridge.attach(
            worker,
            socket,
            "owner",
            step.legacy ? undefined : identity,
          ),
          true,
        );
      } else if (step.op === "request") {
        active = step.name;
        requests.set(active, { worker });
        outcomes[active] = { pending: true };
        let release;
        const gate = new Promise((resolve) => {
          release = resolve;
        });
        gates.set(active, release);
        const name = active;
        const onEvent = step.handler
          ? async (value) => {
              trace.push({ handler: name, event: value });
              if (step.handler.startsWith("hold")) await gate;
              if (step.handler.endsWith("fail"))
                throw new Error("controlled-event-failure");
              trace.push({ handled: name });
            }
          : undefined;
        try {
          bridge
            .request(worker, step.command, {
              timeoutMs: step.timeoutMs,
              onEvent,
            })
            .then(
              (value) => {
                outcomes[name] = {
                  ok: true,
                  ...(value === undefined ? {} : { result: value }),
                };
              },
              (error) => {
                outcomes[name] = fail(error);
              },
            );
        } catch (error) {
          outcomes[name] = fail(error, true);
        }
      } else if (step.op === "response" || step.op === "event") {
        const request = requests.get(step.name);
        if (request?.id) {
          const socket = sockets.get(step.socket ?? request.socket);
          let envelope;
          if (step.op === "event")
            envelope = {
              kind: "event",
              requestId: request.id,
              event: step.event,
            };
          else
            envelope = {
              kind: "response",
              requestId: request.id,
              ok: step.ok !== false,
              ...(step.ok === false
                ? {
                    error: {
                      message: "controlled-worker-failure",
                      ...(step.code === undefined ? {} : { code: step.code }),
                    },
                  }
                : step.missing
                  ? {}
                  : {
                      result: Object.hasOwn(step, "result")
                        ? step.result
                        : { fixture: true },
                    }),
            };
          socket.emit("message", JSON.stringify(envelope), false);
        }
      } else if (step.op === "invalid")
        sockets.get(step.socket).emit("message", step.text, false);
      else if (step.op === "binary")
        sockets.get(step.socket).emit("message", Buffer.from("CWLK"), true);
      else if (step.op === "interrupt")
        sockets
          .get(step.socket)
          .emit("error", new Error("controlled-interruption"));
      else if (step.op === "disconnect")
        bridge.disconnect(worker, "controlled-revocation", step.code);
      else if (step.op === "fail-send") sockets.get(step.socket).fail = true;
      else if (step.op === "release") gates.get(step.name)();
      else if (step.op === "advance") {
        mono += step.ms;
        wall = step.wall ?? wall + step.ms;
        for (;;) {
          const due = [...timers.values()]
            .filter((t) => t.at <= mono)
            .sort((a, b) => a.at - b.at || a.id - b.id)[0];
          if (!due) break;
          timers.delete(due.id);
          due.callback();
          await tick();
        }
      } else if (step.op === "close") bridge.close();
      else throw new Error("Unknown operation " + step.op);
      await tick();
      scenario.snapshots.push(snapshot());
      active = null;
    }
    assert.equal(
      timers.size,
      0,
      "closed bridge owns no live command or reconnect timers",
    );
  }
} finally {
  Date.now = original.now;
  globalThis.setTimeout = original.timeout;
  globalThis.clearTimeout = original.clear;
  if (original.performance)
    Object.defineProperty(performance, "now", original.performance);
  else delete performance.now;
}
console.log(JSON.stringify({ cases }));
