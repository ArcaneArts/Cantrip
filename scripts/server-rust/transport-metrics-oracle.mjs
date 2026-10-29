import { OperationalMetrics } from "../../cantrip_server/src/operations/metrics.ts";
import * as protocol from "../../packages/protocol/dist/index.js";
import { workerLinkWireFixtures } from "./worker-link-wire-fixtures.mjs";
const metrics = new OperationalMetrics(),
  cases = [],
  operations = [];
const render = () =>
  metrics
    .renderPrometheus({
      coordination: {},
      live: {},
      quotas: {},
      tunnels: { terminationsByReason: {} },
      workers: {},
    })
    .split("\n")
    .filter(
      (v) =>
        v.startsWith("cantrip_worker_link_") ||
        v.includes('transport="local-direct"'),
    );
const add = (operation) => {
  operations.push(operation);
  if (operation.type === "direct")
    metrics.recordDirectTransport(
      operation.kind,
      protocol.directTransportTelemetrySchema.parse(operation.value),
    );
  else
    metrics.recordWorkerLinkTelemetry(
      protocol.workerLinkTelemetryBatchSchema.parse({
        routeGeneration: 1,
        samples: operation.value,
      }).samples,
    );
  cases.push({ operations: [...operations], expected: render() });
};
cases.push({ operations: [], expected: render() });
for (const kind of [
  "terminal",
  "browser",
  "remote-desktop",
  "tunnel",
  "worker-link",
  "probe",
])
  for (const n of [0, 7, 9007199254740991])
    add({
      type: "direct",
      kind,
      value: {
        bytesFromLocal: n,
        bytesToLocal: n,
        connectionsClosed: n,
        connectionsOpened: n,
      },
    });
const base =
  workerLinkWireFixtures.workerLinkTelemetryBatchSchema[0].samples[0];
for (const route of [null, "local", "lan", "wan", "relay"])
  for (const lane of [
    null,
    "events",
    "interactive",
    "stream",
    "realtime",
    "bulk",
  ])
    for (const event of [
      "route-selected",
      "route-fallback",
      "bytes-sent",
      "bytes-received",
    ])
      add({
        type: "link",
        value: [
          {
            ...base,
            event,
            route,
            lane,
            value: 7,
            latencyMs: event === "route-selected" ? 0.49999999999999994 : null,
          },
        ],
      });
process.stdout.write(JSON.stringify(cases));
