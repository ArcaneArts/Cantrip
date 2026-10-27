// Development-only oracle: every result comes from the actual Node meter.
import { LiveTrafficMeter } from "../../cantrip_server/src/account-usage/live-traffic-meter.ts";

const epoch = "11111111-1111-4111-8111-111111111111";
const otherEpoch = "22222222-2222-4222-8222-222222222222";
const base = 1_793_059_200_123;
const measurement = (bytes, extra = {}) => ({
  ownerId: "owner",
  channel: "http",
  direction: "ingress",
  bytes,
  ...extra,
});
const record = (bytes, extra = {}) => ({
  op: "record",
  input: measurement(bytes, extra),
});
const snapshot = (extra = {}) => ({ op: "snapshot", owner: "owner", ...extra });
const integer = (value) => ({ integer: String(value) });
const cases = [];
function add(name, steps, options = {}) {
  cases.push({
    name,
    options: { epoch, instanceId: "instance", ...options },
    steps,
  });
}
add(
  "quarter-second samples, revisions, HTTP count and both websocket directions",
  [
    snapshot({ save: "empty" }),
    record(125),
    record(25, { channel: "client-live-websocket", operationCount: 2 }),
    record(75, { channel: "worker-control-websocket", direction: "egress" }),
    { op: "http", owner: "owner", route: "/api/projects" },
    snapshot({ save: "first" }),
    snapshot({ afterFrom: "empty" }),
    snapshot({ afterFrom: "first" }),
    { op: "http", owner: "owner", route: "/api/workers", at: base + 2_000 },
    snapshot({ afterFrom: "first" }),
    snapshot({ owner: "another-owner" }),
    record(3, { notifyChange: false }),
    snapshot(),
  ],
);
add("samples retained without polling, followed by full expiry", [
  { op: "http", owner: "owner", route: "/api/projects", at: base },
  { op: "http", owner: "owner", route: "/api/projects", at: base + 249 },
  { ...record(125, { direction: "egress" }), at: base + 250 },
  { op: "http", owner: "owner", route: "/api/projects", at: base + 500 },
  { op: "http", owner: "owner", route: "/api/projects", at: base + 750 },
  snapshot({ at: base + 300_750 }),
  snapshot({ at: base + 600_750 }),
]);
add("clock moving backwards prunes future samples on the next write", [
  record(1),
  snapshot({ save: "first" }),
  { ...record(2), at: base + 250 },
  snapshot(),
  { ...record(3), at: base - 250 },
  snapshot(),
  snapshot({ afterFrom: "first" }),
]);
for (const value of [
  "",
  "0:0",
  "1:0",
  "not-a-cursor",
  "01:000",
  "1:-1",
  "1:2:3",
  "1:2\n",
  "1:2\r",
  "1:2\r\n",
  "1:2\u2028",
  "1:2\u2029",
  "１:２",
  "9007199254740991:0",
  "9007199254740992:0",
  "0:9007199254740992",
  "0:" + "9".repeat(400),
  "0".repeat(400) + ":0",
  "0:" + "0".repeat(400),
]) {
  add("cursor parsing " + JSON.stringify(value), [
    record(1),
    snapshot({ query: { epoch, after: value } }),
  ]);
}
for (const delta of [-2_400, -2_399, -2_398, -1, 0, 1]) {
  const index = Math.floor(base / 250);
  for (const revision of [0, 1, 2])
    add(`cursor window ${delta}, revision ${revision}`, [
      record(1),
      snapshot({ query: { epoch, after: `${index + delta}:${revision}` } }),
    ]);
}
for (const query of [
  {},
  { epoch },
  { epoch: otherEpoch },
  { after: "0:0" },
  { epoch: "", after: "0:0" },
  { epoch: otherEpoch, after: "0:0" },
]) {
  add("epoch pairing " + JSON.stringify(query), [
    record(1),
    snapshot({ query }),
  ]);
}
for (const value of [
  -1,
  0,
  1,
  1.5,
  9_007_199_254_740_991,
  9_007_199_254_740_992,
  { number: "NaN" },
  { number: "Infinity" },
  integer(-1),
  integer(0),
  integer(1),
  integer(9_007_199_254_740_991n),
  integer(9_223_372_036_854_775_807n),
  integer(10n ** 1000n),
]) {
  for (const field of ["bytes", "operationCount"])
    add(`counter ${field} ${JSON.stringify(value).slice(0, 50)}`, [
      {
        op: "record",
        input: measurement(1, {
          [field]: value,
          channel: "worker-control-websocket",
        }),
      },
      {
        op: "record",
        input: measurement(1, {
          [field]: value,
          channel: "client-live-websocket",
          direction: "egress",
        }),
      },
      snapshot(),
    ]);
}
for (const owner of [
  "",
  "\u00a0\uFEFF\t",
  " \uFEFFowner\u2029",
  "x".repeat(200),
  "x".repeat(201),
  "😀".repeat(100),
  "😀".repeat(101),
  "null\0owner",
]) {
  add(
    "owner validation " +
      Array.from(JSON.stringify(owner)).slice(0, 80).join(""),
    [
      record(1, { ownerId: owner }),
      { op: "http", owner, route: "/api/projects" },
      snapshot({ owner }),
    ],
  );
}
for (const channel of [
  "http",
  "client-live-websocket",
  "worker-control-websocket",
  "terminal-relay",
  "other",
  "unknown",
])
  add("channel " + channel, [
    record(10, { channel, operationCount: 2 }),
    record(20, { channel, direction: "egress", operationCount: 3 }),
    snapshot(),
  ]);
for (const route of [
  "/api/account/live-traffic",
  "/api/account/live-traffic/",
  "/api/account/live-traffic?x=1",
  "/api/account/resource-usage",
  "/api/projects",
])
  add("HTTP route " + route, [
    { op: "http", owner: "owner", route },
    snapshot(),
  ]);
add("no-op and invalid measurements do not consult invalid clocks", [
  { ...record(0, { operationCount: 0 }), at: { number: "NaN" } },
  record(-1),
  record(1, { ownerId: "" }),
  record(1, { direction: "unknown" }),
  record(1),
  { op: "http", owner: "owner", route: "/api/account/live-traffic" },
  { op: "count" },
  snapshot(),
]);
for (const now of [
  0,
  0.9,
  249.99,
  250,
  60_000,
  253_402_300_800_000,
  8_640_000_000_000_000,
  8_640_000_000_000_001,
  1e100,
  -1,
  { number: "NaN" },
  { number: "Infinity" },
]) {
  add("clock " + JSON.stringify(now), [
    { ...record(1), at: now },
    { op: "count" },
    snapshot(),
  ]);
}
add(
  "tie eviction follows insertion order, access updates do not reorder owners",
  [
    record(1, { ownerId: "one" }),
    record(2, { ownerId: "two" }),
    snapshot({ owner: "one" }),
    record(3, { ownerId: "three" }),
    { op: "count" },
    snapshot({ owner: "two" }),
    snapshot({ owner: "one" }),
    snapshot({ owner: "three" }),
  ],
  { maxOwners: 2 },
);
add(
  "retention is strictly older than the cutoff and eviction runs once per second",
  [
    { ...record(1, { ownerId: "one" }), at: 0 },
    { ...record(2, { ownerId: "two" }), at: 1_000 },
    { op: "count", at: 600_000 },
    snapshot({ owner: "one" }),
    { op: "count", at: 601_000 },
    { op: "count", at: 1_202_000 },
  ],
  { ownerRetentionSeconds: 600 },
);
for (const options of [
  { instanceId: "" },
  { instanceId: "\uFEFF \n" },
  { instanceId: "😀".repeat(50) },
  { instanceId: "😀".repeat(51) },
  { maxOwners: 0 },
  { ownerRetentionSeconds: 599 },
  { instanceId: " \uFEFFinstance\u2029" },
])
  add("options " + JSON.stringify(options), [record(1), snapshot()], options);
// A repeatable mixed workload checks pruning, revisions, owner isolation and
// relative cursors across many quarter-second boundaries.
for (let seed = 1; seed <= 12; seed += 1) {
  const steps = [];
  let at = base;
  for (let i = 0; i < 35; i += 1) {
    at += ((seed * 17 + i * 31) % 7) * 125;
    steps.push({
      ...record((i + 1) * seed, {
        ownerId: `owner-${i % 3}`,
        channel: i % 2 ? "http" : "client-live-websocket",
        direction: i % 3 ? "ingress" : "egress",
        operationCount: i % 4,
      }),
      at,
    });
    if (i % 7 === 0)
      steps.push(
        snapshot({
          owner: `owner-${i % 3}`,
          save: "last",
          ...(i > 0 ? { afterFrom: "last" } : {}),
        }),
      );
  }
  steps.push({ op: "count" });
  add("mixed workload " + seed, steps, { maxOwners: 3 });
}
function revive(value) {
  if (value && typeof value === "object" && "integer" in value)
    return BigInt(value.integer);
  if (value && typeof value === "object" && "number" in value)
    return Number(value.number);
  return value;
}
let count = 0;
for (const scenario of cases) {
  let now = base;
  let meter;
  let outcome;
  try {
    meter = new LiveTrafficMeter({ ...scenario.options, now: () => now });
  } catch (error) {
    outcome = { constructorError: error.message };
  }
  if (meter) {
    outcome = [];
    const saved = new Map();
    for (const step of scenario.steps) {
      if ("at" in step) now = revive(step.at);
      try {
        let value;
        if (step.op === "record") {
          const input = { ...step.input };
          for (const field of ["bytes", "operationCount"])
            if (field in input) input[field] = revive(input[field]);
          value = meter.record(input);
        } else if (step.op === "http")
          value = meter.recordHttpRequest(step.owner, step.route);
        else if (step.op === "count") value = meter.ownerCount();
        else {
          const query = step.afterFrom
            ? {
                epoch: saved.get(step.afterFrom).epoch,
                after: saved.get(step.afterFrom).cursor,
              }
            : step.query;
          value = meter.snapshot(step.owner, query);
          if (step.save) saved.set(step.save, value);
        }
        outcome.push({ value });
      } catch (error) {
        outcome.push({ error: error.message });
      }
    }
  }
  process.stdout.write(
    JSON.stringify({ id: count++, scenario, outcome }) + "\n",
  );
}
process.stdout.write(JSON.stringify({ done: count }) + "\n");
