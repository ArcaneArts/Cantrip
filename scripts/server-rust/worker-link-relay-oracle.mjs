import { WorkerLinkRelay } from "../../cantrip_server/src/worker-links/relay.ts";
import { createWorkerLinkFrame } from "../../packages/protocol/dist/worker-link.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
const clone = structuredClone;
const b64 = (v) => Buffer.from(v).toString("base64");
const uuid = (n) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const session = clone(workerLinkWireFixtures.workerLinkSessionSchema[0]);
session.routePolicy.enabled = ["local", "relay"];
session.preferredRoute = "relay";
const open = (n = 1, lane = "interactive", kind = "terminal", grant = n) => {
  const value = clone(workerLinkWireFixtures.workerLinkFrameHeaderSchema[0]);
  Object.assign(value, {
    sessionId: session.sessionId,
    routeGeneration: session.routeGeneration,
    effectiveRoute: "relay",
    channel: { channelId: uuid(n + 20), connectionId: uuid(n + 40) },
    lane,
    openNonce: uuid(n + 60),
    sequence: 0,
  });
  Object.assign(value.grant.binding, {
    grantId: uuid(grant + 100),
    sessionId: session.sessionId,
    identity: session.identity,
    lease: session.lease,
    lanes: ["events", "interactive", "stream", "realtime", "bulk"],
    maxChannels: 10,
  });
  value.grant.binding.resource.kind = kind;
  return value;
};
const frame = (open, kind, sequence, extra = {}) => {
  const {
    protocolVersion,
    sessionId,
    routeGeneration,
    effectiveRoute,
    channel,
    lane,
  } = open;
  return {
    protocolVersion,
    sessionId,
    routeGeneration,
    effectiveRoute,
    channel,
    lane,
    sequence,
    kind,
    ...extra,
  };
};
const client = (header, payload = []) => ({ op: "client", header, payload });
const worker = (header, payload = []) => ({ op: "worker", header, payload });
const accept = (o) =>
  worker(frame(o, "accept", 0, { initialCreditBytes: 1024 }));
const data = (o, sequence, direction = "worker-to-client") =>
  frame(o, "data", sequence, { direction, payloadFormat: "raw" });
const connect = (name = "a", active = session) => ({
  op: "attach",
  name,
  session: active,
});
const cases = [];
const add = (name, actions, options = {}) =>
  cases.push({ name, options, actions: [connect(), ...actions] });
const a = open(),
  b = open(2),
  bulk = open(3, "bulk");
add("bidirectional frames", [
  client(a),
  accept(a),
  client(data(a, 1, "client-to-worker"), [1, 2, 255]),
  worker(data(a, 1), [3, 4]),
  client(frame(a, "half-close", 2, { direction: "client-to-worker" })),
  worker(frame(a, "credit", 2, { direction: "client-to-worker", bytes: 10 })),
  worker(frame(a, "close", 3, { code: "normal" })),
]);
add("closing tombstone retains siblings", [
  client(a),
  accept(a),
  client(b),
  accept(b),
  client(frame(a, "close", 1, { code: "normal" })),
  worker(data(a, 1), [1]),
  worker(frame(a, "close", 2, { code: "normal" })),
  worker(data(b, 1), [2]),
  client(data(a, 2, "client-to-worker"), [3]),
]);
add("channel replay", [client(a), client(a)]);
add("malformed frame", [{ op: "client", raw: b64(Buffer.from("CWLK")) }]);
add("text frame", [
  { op: "client", raw: b64(Buffer.from("text")), binary: false },
]);
add("stale client generation", [
  client({ ...a, routeGeneration: a.routeGeneration + 1 }),
]);
add("stale worker generation ignored", [
  client(a),
  worker({
    ...frame(a, "accept", 0, { initialCreditBytes: 1024 }),
    routeGeneration: a.routeGeneration + 1,
  }),
  accept(a),
]);
add("worker must accept first", [client(a), worker(data(a, 0), [1])]);
add("worker sequence gap", [client(a), accept(a), worker(data(a, 2), [1])]);
add("worker channel identity mismatch", [
  client(a),
  accept(a),
  worker(
    { ...data(a, 1), channel: { ...a.channel, connectionId: uuid(999) } },
    [1],
  ),
]);
add("worker lane mismatch", [
  client(a),
  accept(a),
  worker({ ...data(a, 1), lane: "bulk" }, [1]),
]);
add("client endpoint remains worker authority", [
  client(a),
  client(
    {
      ...data(a, 1, "client-to-worker"),
      channel: { ...a.channel, connectionId: uuid(999) },
    },
    [1],
  ),
]);
add(
  "payload quota failure retains ingress",
  [client(a), accept(a), client(data(a, 1, "client-to-worker"), [1, 2, 3])],
  { budget: 2 },
);
const surface1 = open(4, "interactive", "browser", 4),
  surface2 = open(5, "realtime", "browser", 4),
  surface3 = open(6, "interactive", "remote-desktop", 6),
  surface4 = open(7, "interactive", "browser", 7);
add(
  "surface grant shares quota across lanes",
  [
    client(surface1),
    client(surface2),
    client(frame(surface1, "close", 1, { code: "normal" })),
    client(frame(surface2, "close", 1, { code: "normal" })),
    client(surface3),
    client(surface4),
  ],
  { surfaceLimit: 1 },
);
add("fair lane drain", [
  { op: "buffer", bytes: 9 * 1024 * 1024 },
  client(bulk),
  accept(bulk),
  client(a),
  accept(a),
  worker(data(bulk, 1), [1]),
  worker(data(a, 1), [2]),
  { op: "buffer", bytes: 0 },
  { op: "tick" },
]);
add(
  "independent queue frame bound",
  [
    { op: "buffer", bytes: 9 * 1024 * 1024 },
    client(a),
    accept(a),
    worker(data(a, 1), [1]),
  ],
  { queueFrames: 1 },
);
add(
  "independent queue byte bound",
  [{ op: "buffer", bytes: 9 * 1024 * 1024 }, client(a), accept(a)],
  { queueBytes: 100 },
);
add("slow client deadline", [
  { op: "buffer", bytes: 9 * 1024 * 1024 },
  client(a),
  accept(a),
  { op: "clock", now: 4999 },
  { op: "tick" },
  { op: "clock", now: 5000 },
  { op: "tick" },
]);
add("send failure", [client(a), { op: "send-fails" }, accept(a)]);
add("worker offline retires relay", [client(a), accept(a), { op: "offline" }]);
add("relay replacement fences old client", [
  client(a),
  connect("b"),
  { ...client(data(a, 1, "client-to-worker"), [1]), name: "a" },
  { op: "select", name: "b" },
  client(b),
  accept(b),
]);
add("account scope", [
  client(a),
  { op: "revoke-account", id: "foreign" },
  { op: "revoke-account", id: session.identity.accountSessionId },
]);
add("owner scope", [
  client(a),
  { op: "revoke-owner", id: session.identity.ownerId },
]);
add("session scope", [
  client(a),
  { op: "revoke-session", id: session.sessionId },
]);
add("relay standby", [client(a)], { preferredRoute: "local" });
add("relay disabled", [], { relayDisabled: true });
add("global close", [client(a), { op: "close" }]);
for (const kind of [
  "terminal",
  "browser",
  "remote-desktop",
  "project-share",
  "tunnel",
  "observations",
]) {
  const value = open(1, "interactive", kind);
  add("traffic channel " + kind, [
    client(value),
    accept(value),
    worker(data(value, 1), [1, 2, 3]),
    worker(frame(value, "close", 2, { code: "normal" })),
  ]);
}

for (const test of cases) {
  let now = 0,
    available = true,
    active = 0,
    used = 0,
    selected = "a",
    nextTimer = 0;
  const sent = [],
    meter = [],
    quota = [],
    surfaces = [],
    listeners = new Set(),
    offline = new Set(),
    timers = new Map(),
    sockets = new Map();
  const bridge = {
    sendWorkerLinkFrame(worker, frame) {
      if (!available) return false;
      sent.push({ worker, bytes: b64(frame.bytes) });
      return true;
    },
    subscribeWorkerLinkFrames(worker, listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    subscribeWorkerOffline(worker, listener) {
      offline.add(listener);
      return () => offline.delete(listener);
    },
    subscribeWorkerDisconnect() {
      return () => {};
    },
  };
  const lane = {
    maxChannels: 64,
    maxQueuedFrames: test.options.queueFrames ?? 8,
    maxQueuedBytes: test.options.queueBytes ?? 65536,
    maxBytesPerSecond: 65536,
  };
  const relay = new WorkerLinkRelay(bridge, {
    laneLimits: Object.fromEntries(
      ["events", "interactive", "stream", "realtime", "bulk"].map((k) => [
        k,
        lane,
      ]),
    ),
    now: () => now,
    setTimer(callback) {
      const id = ++nextTimer;
      timers.set(id, callback);
      return id;
    },
    clearTimer(id) {
      timers.delete(id);
    },
    acquireRemoteSurface(owner, worker) {
      if (active >= (test.options.surfaceLimit ?? 100))
        throw new Error("controlled surface quota");
      active++;
      surfaces.push(["acquire", owner, worker]);
      return () => {
        active--;
        surfaces.push(["release", owner, worker]);
      };
    },
    consumeRelayBytes(owner, worker, bytes) {
      quota.push([owner, worker, bytes]);
      if (used + bytes > (test.options.budget ?? 1000000)) return false;
      used += bytes;
      return true;
    },
    usageRecorder: {
      record(v) {
        meter.push(v);
      },
    },
  });
  test.observations = [];
  for (const action of test.actions) {
    let error = null;
    try {
      switch (action.op) {
        case "attach": {
          selected = action.name;
          const s = {
            readyState: 1,
            bufferedAmount: 0,
            closes: [],
            sent: [],
            callbacks: new Map(),
            fail: false,
            on(event, listener) {
              const list = this.callbacks.get(event) ?? [];
              list.push(listener);
              this.callbacks.set(event, list);
            },
            close(code, reason) {
              if (this.readyState !== 1) return;
              this.readyState = 3;
              this.closes.push({ code, reason });
              for (const cb of this.callbacks.get("close") ?? []) cb();
            },
            send(bytes) {
              if (this.fail) throw new Error("controlled send failure");
              this.sent.push(b64(bytes));
            },
          };
          sockets.set(selected, s);
          const active = clone(action.session);
          if (test.options.preferredRoute)
            active.preferredRoute = test.options.preferredRoute;
          if (test.options.relayDisabled) {
            active.routePolicy.enabled = ["local"];
            active.preferredRoute = "local";
          }
          relay.attach(active, s);
          break;
        }
        case "select":
          selected = action.name;
          break;
        case "client": {
          const socket = sockets.get(action.name ?? selected);
          const bytes =
            action.raw === undefined
              ? createWorkerLinkFrame(
                  action.header,
                  Uint8Array.from(action.payload),
                ).bytes
              : Buffer.from(action.raw, "base64");
          for (const cb of socket.callbacks.get("message") ?? [])
            cb(bytes, action.binary ?? true);
          break;
        }
        case "worker": {
          const frame = createWorkerLinkFrame(
            action.header,
            Uint8Array.from(action.payload),
          );
          for (const listener of listeners) listener(frame);
          break;
        }
        case "buffer":
          sockets.get(selected).bufferedAmount = action.bytes;
          break;
        case "clock":
          now = action.now;
          break;
        case "tick": {
          const next = timers.entries().next().value;
          if (next) {
            timers.delete(next[0]);
            next[1]();
          }
          break;
        }
        case "send-fails":
          sockets.get(selected).fail = true;
          break;
        case "offline":
          available = false;
          for (const cb of offline) cb();
          break;
        case "revoke-owner":
          relay.revokeOwner(action.id);
          break;
        case "revoke-account":
          relay.revokeAccountSession(action.id);
          break;
        case "revoke-session":
          relay.revokeSession(action.id);
          break;
        case "close":
          relay.close();
          break;
      }
    } catch (e) {
      error = e.message;
    }
    test.observations.push({
      stats: relay.stats(),
      sent: clone(sent),
      sockets: Object.fromEntries(
        [...sockets].map(([k, s]) => [
          k,
          { closes: clone(s.closes), sent: clone(s.sent) },
        ]),
      ),
      meter: clone(meter),
      quota: clone(quota),
      surfaces: clone(surfaces),
      active,
      used,
      error,
    });
  }
  relay.close();
}
console.log(JSON.stringify({ session, cases }));
