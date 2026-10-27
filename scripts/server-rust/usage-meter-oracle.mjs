// Manual-flush state comparisons execute the actual Node meter. Timer/service
// acceptance is separate; the threshold keeps these deterministic scenarios idle.
import assert from "node:assert/strict";
import { once } from "node:events";
import { AccountUsageMeter } from "../../cantrip_server/src/account-usage/bandwidth-meter.ts";
const logger = { event() {}, rateLimited() {} };
const originalNow = Date.now;
let clock = 1793059200123;
Date.now = () => clock;
const encoded = (value) =>
  JSON.stringify(value, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value,
  );
const clone = (value) => JSON.parse(encoded(value));
const counter = (value) =>
  value && typeof value === "object" && Object.hasOwn(value, "integer")
    ? BigInt(value.integer)
    : value && typeof value === "object" && Object.hasOwn(value, "number")
      ? Number(value.number)
      : value;
const record = (input = {}, extra = {}) => ({
  op: "record",
  input: {
    ownerId: "owner",
    bytes: 7,
    channel: "http",
    direction: "egress",
    ...input,
  },
  ...extra,
});
const start = { op: "start" },
  success = { op: "success", result: { applied: true, ownerIds: ["owner"] } },
  failure = { op: "failure" },
  close = { op: "close" };
const scenarios = [
  {
    name: "pending delta and retry receipt",
    steps: [
      record(),
      start,
      record({ bytes: 11 }),
      failure,
      { ...start, at: 1793059200130 },
      start,
      record({ bytes: 13 }),
      { ...success, at: 1793059200140 },
      start,
      success,
      close,
    ],
  },
  {
    name: "observer and notification dimensions",
    maxEntries: 1,
    steps: [
      record({ notifyChange: false }),
      record({ ownerId: "other" }),
      start,
      success,
      record(),
      start,
      { ...success, result: { applied: false, ownerIds: ["owner"] } },
      close,
    ],
  },
  {
    name: "observer callback rejection is isolated",
    observerThrows: true,
    publicationThrows: true,
    steps: [record(), start, success, close, record()],
  },
  {
    name: "shutdown retries pending failure twice",
    steps: [
      record(),
      start,
      failure,
      { op: "close", replies: [{ reject: true }, { reject: true }] },
      record(),
      close,
    ],
  },
  {
    name: "shutdown succeeds after first retry failure",
    steps: [
      record(),
      {
        op: "close",
        replies: [
          { reject: true },
          { result: { applied: true, ownerIds: ["owner"] } },
        ],
      },
      record(),
    ],
  },
  {
    name: "empty flush and zero measurement",
    steps: [
      start,
      record({ bytes: 0, operationCount: 0 }),
      start,
      close,
      record(),
    ],
  },
  {
    name: "per-dimension PostgreSQL integer overflow",
    steps: [
      record({ bytes: { integer: "9223372036854775807" } }),
      record({ bytes: 1 }),
      record({ bytes: 0, operationCount: { integer: "9223372036854775807" } }),
      start,
      success,
      close,
    ],
  },
];
for (const bytes of [
  null,
  false,
  "1",
  -1,
  -0,
  0,
  0.5,
  1,
  9007199254740991,
  9007199254740992,
  { integer: "9007199254740993" },
  { integer: "9223372036854775807" },
  { integer: "9223372036854775808" },
  { integer: "-1" },
  { number: "NaN" },
  { number: "Infinity" },
  { number: "-Infinity" },
])
  for (const operationCount of [
    undefined,
    0,
    1,
    { integer: "9223372036854775807" },
    -1,
    0.5,
  ])
    scenarios.push({
      name: "counter combinations",
      steps: [
        record({
          bytes,
          ...(operationCount === undefined ? {} : { operationCount }),
        }),
        close,
      ],
    });
for (const ownerId of [
  "",
  " ",
  "\ufeff owner \ufeff",
  "🦀".repeat(100),
  "🦀".repeat(101),
  "owner\0suffix",
])
  for (const channel of [
    "http",
    "client-live-websocket",
    "worker-control-websocket",
    "attachment-transfer",
    "invalid",
  ])
    for (const direction of ["ingress", "egress", "invalid"])
      scenarios.push({
        name: "owner, channel and direction",
        steps: [record({ ownerId, channel, direction }), close],
      });
for (const at of [
  -62167219200000, -59037840000000, -1, 0, 1, 1793059199999, 1793059200000,
  253402300800000, -62198755200000,
])
  scenarios.push({
    name: "UTC hour and ISO year boundaries",
    steps: [
      record({}, { at }),
      start,
      record({ bytes: 11 }, { at: at + 3600000 }),
      success,
      start,
      success,
      close,
    ],
  });
scenarios.push({
  name: "invalid measurement clock",
  steps: [record({}, { at: "NaN" }), record({}, { at: 1793059200123 }), close],
});
try {
  for (const [id, scenario] of scenarios.entries()) {
    clock = 1793059200123;
    let pending, active, closingReplies;
    const batches = [],
      observations = [],
      publications = [],
      outcome = [];
    const sink = {
      flushBandwidthBatch(batch) {
        batches.push(clone(batch));
        if (closingReplies) {
          const reply = closingReplies.shift() ?? {
            result: {
              applied: true,
              ownerIds: [...new Set(batch.entries.map((e) => e.ownerId))],
            },
          };
          return reply.reject
            ? Promise.reject(new Error("controlled sink failure"))
            : Promise.resolve(reply.result);
        }
        return new Promise((resolve, reject) => {
          pending = { resolve, reject };
        });
      },
    };
    const meter = new AccountUsageMeter(sink, logger, {
      meterId: "fixture-meter",
      maxBufferedEntries: scenario.maxEntries ?? 3,
      flushThresholdBytes: 10n ** 100n,
      now: () => new Date(clock),
      onMeasurement(value) {
        observations.push(clone(value));
        if (scenario.observerThrows)
          throw new Error("controlled observer failure");
      },
      onFlushed(owners) {
        publications.push(owners);
        if (scenario.publicationThrows)
          throw new Error("controlled publication failure");
      },
    });
    try {
      for (const step of scenario.steps) {
        if (Object.hasOwn(step, "at")) clock = Number(step.at);
        let value;
        if (step.op === "record")
          value = meter.record({
            ...step.input,
            bytes: counter(step.input.bytes),
            ...(Object.hasOwn(step.input, "operationCount")
              ? { operationCount: counter(step.input.operationCount) }
              : {}),
          });
        else if (step.op === "start") {
          const before = batches.length,
            previous = active,
            started = meter.flush();
          if (batches.length > before) {
            active = started;
            value = { started: true, shared: false };
          } else if (previous) {
            assert.equal(started, previous);
            value = { started: false, shared: true };
          } else
            value = {
              started: false,
              shared: false,
              emptyResult: await started,
            };
        } else if (step.op === "success" || step.op === "failure") {
          assert(pending && active);
          const target = pending;
          pending = null;
          if (step.op === "success") target.resolve(step.result);
          else target.reject(new Error("controlled sink failure"));
          value = await active;
          active = null;
        } else if (step.op === "close") {
          assert(!active);
          closingReplies = [...(step.replies ?? [])];
          await meter.close();
          value = null;
        } else throw new Error("Unknown meter fixture step");
        outcome.push(
          clone({
            value,
            stats: meter.stats(),
            batches,
            observations,
            publications,
          }),
        );
      }
    } finally {
      closingReplies = [];
      await meter.close();
    }
    const line = encoded({ id, scenario, outcome }) + "\n";
    if (!process.stdout.write(line)) await once(process.stdout, "drain");
  }
  console.log(
    encoded({
      done: scenarios.length,
      scope:
        "Actual meter manual-flush state; service timers and transport accounting require separate acceptance.",
    }),
  );
} finally {
  Date.now = originalNow;
}
