import { TunnelStreamBroker } from "../../cantrip_server/src/tunnels/broker.ts";
import { tunnelRecord } from "./tunnel-record-fixture.mjs";
const base = {
  protocolVersion: 1,
  tunnelId: "tunnel",
  attachmentId: "attachment",
  sourceEndpointId: "desktop",
  destinationEndpointId: "worker",
  connectionId: "connection",
  sequence: 0,
};
const target = {
  kind: "protected-tunnel",
  targetKind: "tcp",
  recordId: "tunnel",
  protectedRecord: tunnelRecord,
};
class Endpoint {
  listeners = new Set();
  disconnected = new Set();
  constructor(endpointId, send) {
    this.endpointId = endpointId;
    this.placement = { kind: "server-adapter", adapterId: endpointId };
    this.send = send;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  subscribeDisconnect(listener) {
    this.disconnected.add(listener);
    return () => this.disconnected.delete(listener);
  }
  emit(header, payload) {
    for (const listener of this.listeners) listener(header, payload);
  }
  disconnect() {
    for (const listener of this.disconnected) listener();
  }
}
function execute(input) {
  let now = 0,
    active = true,
    consume = true,
    activityRevoke = false,
    sendRevoke = false,
    sourceSend = true,
    destinationSend = true,
    broker;
  const trace = [],
    handles = new Map();
  const send = (side) => (header, payload) => {
    trace.push({
      event: "send",
      side,
      header: structuredClone(header),
      payload: Buffer.from(payload).toString("base64"),
    });
    if (sendRevoke) {
      sendRevoke = false;
      broker.revokeAttachment(header.attachmentId);
    }
    return side === "source" ? sourceSend : destinationSend;
  };
  const source = new Endpoint("desktop", send("source")),
    destination = new Endpoint("worker", send("destination"));
  broker = new TunnelStreamBroker({
    ...input.options,
    now: () => now,
    onActivity: (tunnelId, attachmentId) => {
      trace.push({ event: "activity", tunnelId, attachmentId });
      if (activityRevoke) {
        activityRevoke = false;
        broker.revokeAttachment(attachmentId);
      }
      return active;
    },
    consumeRelayBytes: (ownerId, workerId, bytes) => {
      trace.push({ event: "consume", ownerId, workerId, bytes });
      return consume;
    },
  });
  const observations = [];
  try {
    for (const action of input.actions) {
      let result = null;
      try {
        switch (action.op) {
          case "register":
            handles.set(
              action.name ?? "main",
              broker.registerRoute({
                tunnelId: action.tunnelId ?? "tunnel",
                attachmentId: action.attachmentId ?? "attachment",
                source,
                destination: action.equal ? source : destination,
                destinationTarget: target,
                ownerId: "owner",
                workerId: "worker",
                ...(action.diagnosticTraceId === undefined
                  ? {}
                  : { diagnosticTraceId: action.diagnosticTraceId }),
              }),
            );
            break;
          case "frame": {
            const header = { ...base, ...action.header },
              payload = action.payload
                ? Uint8Array.from(action.payload)
                : new Uint8Array(action.payloadLength ?? 0).fill(91);
            (action.side === "destination" ? destination : source).emit(
              header,
              payload,
            );
            break;
          }
          case "close-handle":
            handles.get(action.name ?? "main")?.close();
            break;
          case "disconnect":
            (action.side === "destination" ? destination : source).disconnect();
            break;
          case "revoke":
            result = broker.revokeAttachment(
              action.attachmentId ?? "attachment",
            );
            break;
          case "activity":
            result = broker.recordRouteActivity(
              action.tunnelId ?? "tunnel",
              action.attachmentId ?? "attachment",
            );
            break;
          case "flags":
            if (action.now !== undefined) now = action.now;
            if (action.active !== undefined) active = action.active;
            if (action.consume !== undefined) consume = action.consume;
            if (action.activityRevoke !== undefined)
              activityRevoke = action.activityRevoke;
            if (action.sendRevoke !== undefined) sendRevoke = action.sendRevoke;
            if (action.sourceSend !== undefined) sourceSend = action.sourceSend;
            if (action.destinationSend !== undefined)
              destinationSend = action.destinationSend;
            break;
          case "sweep":
            broker.sweep(action.now);
            break;
          case "close":
            broker.close();
            break;
          default:
            throw new Error("Unknown broker fixture action");
        }
      } catch (error) {
        result = { error: error.message };
      }
      observations.push({
        result,
        trace: structuredClone(trace),
        stats: broker.stats(),
      });
    }
  } finally {
    broker.close();
  }
  return observations;
}
const register = { op: "register" },
  open = { op: "frame", header: { kind: "open", initialCreditBytes: 8 } },
  accepted = {
    op: "frame",
    side: "destination",
    header: { kind: "accepted", initialCreditBytes: 8 },
  };
const flags = (v) => ({ op: "flags", ...v });
const source = (kind, sequence, fields = {}, payloadLength = 0) => ({
  op: "frame",
  header: { kind, sequence, ...fields },
  payloadLength,
});
const dest = (kind, sequence, fields = {}, payloadLength = 0) => ({
  ...source(kind, sequence, fields, payloadLength),
  side: "destination",
});
const scenarios = [];
function add(name, actions, options = {}) {
  const input = { actions: [...actions, { op: "close" }], options };
  scenarios.push({ name, input, outcome: execute(input) });
}
add("credited bidirectional stream", [
  register,
  open,
  accepted,
  source("data", 1, { direction: "source-to-destination" }, 3),
  dest("data", 1, { direction: "destination-to-source" }, 2),
  source("credit", 2, { direction: "destination-to-source", bytes: 3 }),
  dest("credit", 2, { direction: "source-to-destination", bytes: 3 }),
  source("half-close", 3, { direction: "source-to-destination" }),
  dest("half-close", 3, { direction: "destination-to-source" }),
  source("close", 4, { code: "normal" }),
]);
add("opaque authenticated payload charges plaintext credit", [
  register,
  source("open", 0, { initialCreditBytes: 3 }),
  dest("accepted", 0, { initialCreditBytes: 3 }),
  source(
    "data",
    1,
    {
      direction: "source-to-destination",
      protection: {
        formatVersion: 1,
        algorithm: "AES-256-GCM",
        keyRevision: 1,
        nonce: "AAAAAAAAAAAAAAAA",
      },
    },
    19,
  ),
]);
for (const side of ["source", "destination"])
  for (const kind of [
    "open",
    "connect",
    "accepted",
    "rejected",
    "data",
    "credit",
    "half-close",
    "close",
    "error",
  ])
    add("allowed kind " + side + "/" + kind, [
      register,
      open,
      accepted,
      {
        op: "frame",
        side,
        header: {
          kind,
          sequence: 1,
          initialCreditBytes: 8,
          bytes: 1,
          direction:
            side === "source"
              ? "source-to-destination"
              : "destination-to-source",
          code: "normal",
        },
        payloadLength: kind === "data" ? 1 : 0,
      },
    ]);
for (const sequence of [0, 2, 9007199254740991])
  add("sequence " + sequence, [
    register,
    open,
    accepted,
    source("data", sequence, { direction: "source-to-destination" }, 1),
  ]);
for (const payloadLength of [0, 16, 17, 65536, 65552, 65553])
  add("protected payload " + payloadLength, [
    register,
    source("open", 0, { initialCreditBytes: 8388608 }),
    dest("accepted", 0, { initialCreditBytes: 8388608 }),
    source(
      "data",
      1,
      { direction: "source-to-destination", protection: {} },
      payloadLength,
    ),
  ]);
add("control payload rejected", [register, { ...open, payloadLength: 1 }]);
add("rejected target closes opening connection", [
  register,
  open,
  dest("rejected", 0, { code: "target-unavailable" }),
]);
add("credit overflow", [
  register,
  open,
  accepted,
  source("credit", 1, { direction: "destination-to-source", bytes: 8388608 }),
]);
add("data after half close", [
  register,
  open,
  accepted,
  source("half-close", 1, { direction: "source-to-destination" }),
  source("data", 2, { direction: "source-to-destination" }, 1),
]);
add("source data before accepted", [
  register,
  open,
  source("data", 1, { direction: "source-to-destination" }, 1),
]);
add("new open bad sequence", [
  register,
  source("open", 1, { initialCreditBytes: 8 }),
]);
add("source congestion", [
  register,
  open,
  flags({ sourceSend: false }),
  accepted,
]);
add("destination congestion", [
  register,
  flags({ destinationSend: false }),
  open,
]);
add("activity rejection before open", [
  register,
  flags({ active: false }),
  open,
]);
add("activity rejection after accepted", [
  register,
  open,
  accepted,
  flags({ active: false }),
  source("data", 1, { direction: "source-to-destination" }, 1),
]);
add("activity synchronously revokes pending open", [
  register,
  flags({ activityRevoke: true }),
  open,
]);
add("activity synchronously revokes existing connection", [
  register,
  open,
  accepted,
  flags({ activityRevoke: true }),
  source("data", 1, { direction: "source-to-destination" }, 1),
]);
add("connect send synchronously revokes route", [
  register,
  flags({ sendRevoke: true }),
  open,
]);
add("termination send reenters revocation", [
  register,
  open,
  accepted,
  flags({ sendRevoke: true }),
  source("data", 99, { direction: "source-to-destination" }, 1),
]);
add("quota rejects ciphertext bytes", [
  register,
  open,
  accepted,
  flags({ consume: false }),
  source("data", 1, { direction: "source-to-destination" }, 1),
]);
add(
  "bandwidth window reset",
  [
    register,
    open,
    accepted,
    source("data", 1, { direction: "source-to-destination" }, 2),
    flags({ now: 1000 }),
    source("data", 2, { direction: "source-to-destination" }, 2),
    source("data", 3, { direction: "source-to-destination" }, 1),
  ],
  { maxBytesPerSecond: 2 },
);
add(
  "idle threshold",
  [register, open, accepted, { op: "sweep", now: 9 }, { op: "sweep", now: 10 }],
  { idleTimeoutMs: 10 },
);
add("lifetime priority", [register, open, accepted, { op: "sweep", now: 10 }], {
  idleTimeoutMs: 10,
  maxLifetimeMs: 10,
});
add(
  "route count and duplicate priority",
  [
    register,
    register,
    { op: "register", tunnelId: "other", attachmentId: "other" },
  ],
  { maxRoutes: 1 },
);
add("distinct endpoints priority", [{ op: "register", equal: true }], {
  maxRoutes: 0,
});
add(
  "global connection count",
  [
    register,
    open,
    source("open", 0, { initialCreditBytes: 8, connectionId: "second" }),
  ],
  { maxConnections: 1 },
);
add(
  "per tunnel across attachments",
  [
    register,
    { op: "register", name: "second", attachmentId: "second" },
    open,
    source("open", 0, { initialCreditBytes: 8, attachmentId: "second" }),
  ],
  { maxConnectionsPerTunnel: 1 },
);
add("identity mismatches ignored", [
  register,
  open,
  source(
    "data",
    9,
    { tunnelId: "foreign", direction: "source-to-destination" },
    1,
  ),
  source(
    "data",
    9,
    { sourceEndpointId: "foreign", direction: "source-to-destination" },
    1,
  ),
  dest("accepted", 0, { initialCreditBytes: 8, connectionId: "missing" }),
  accepted,
]);
add("stale close handle cannot close replacement", [
  register,
  open,
  { op: "close-handle" },
  { op: "register", name: "replacement" },
  open,
  { op: "close-handle" },
  accepted,
]);
add("disconnect and activity", [
  register,
  open,
  accepted,
  { op: "activity" },
  { op: "disconnect" },
  { op: "activity" },
  { op: "revoke" },
]);
add("explicit revocation", [register, open, accepted, { op: "revoke" }]);
add("diagnostic binds generated connect", [
  { op: "register", diagnosticTraceId: "99999999-9999-4999-8999-000000000001" },
  open,
]);
console.log(JSON.stringify({ base, target, scenarios }));
