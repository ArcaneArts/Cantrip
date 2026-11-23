import assert from "node:assert/strict";
import {
  sourceContractSchema,
  computerUseHttpContractRoots,
} from "./contracts.mjs";
import { outcome, vectorCases } from "./security-oracle.mjs";
import { id, input, opaque } from "./computer-use-http-fixtures.mjs";
import {
  activityEvent,
  agentBinding,
} from "./computer-use-http-additional.mjs";

const session = {
  binding: {
    chatId: "chat",
    taskId: null,
    workerId: "worker",
    threadId: "thread",
    turnId: "turn",
    sessionId: "session",
  },
  target: {
    id: "window",
    generation: 1,
    kind: "window",
    title: "Window",
    application: null,
    processId: null,
    focused: false,
    minimized: false,
    bounds: { x: -20, y: 40, width: 400, height: 200 },
    pixelWidth: 800,
    pixelHeight: 400,
    scaleFactor: 2,
  },
  cursor: {
    appearance: {
      version: 1,
      style: "dot",
      color: "#ffffff",
      size: 12,
      label: null,
      trail: false,
      visible: true,
    },
    position: { x: 10, y: 20 },
    trailPoints: [],
    updatedAtMs: 1,
    revision: 2,
  },
  observationRevision: 3,
};
const image = {
  mediaType: "image/png",
  width: 400,
  height: 200,
  byteCount: 100,
  sha256: "a".repeat(64),
  cursorIncluded: true,
};
const observation = {
  source: {
    sourceId: id(4),
    rootThreadId: "thread",
    binding: session.binding,
    target: session.target,
    cursorRevision: 2,
    observationRevision: 3,
    observedAtMs: 2,
  },
  session,
  image,
  nativeImage: { ...image, width: 800, height: 400 },
};
const list = {
  status: "ok",
  operation: "agent.sources.list",
  data: { sources: [observation.source] },
  chunkCount: 0,
};
const capture = {
  status: "ok",
  operation: "agent.observation.get",
  data: observation,
  chunkCount: 1,
};

const samples = {
  computerUseRequestSchema: [input(), input(2, "input.perform")],
  computerUseResponseSchema: [
    { operationId: id(1), protectedContent: opaque() },
  ],
  computerUseChunkEventSchema: [
    {
      type: "computer-use.snapshot.chunk",
      operationId: id(1),
      sequence: 0,
      protectedContent: opaque(),
    },
  ],
  computerUseHttpResultSchema: [
    {
      response: { operationId: id(1), protectedContent: opaque() },
      chunks: [],
    },
  ],
  computerUseActivityEventSchema: [
    activityEvent(id(1), id(2)),
    activityEvent(id(1), id(2), true),
  ],
  cuaPreviewLeaseSchema: [
    {
      leaseId: id(3),
      workerId: "worker",
      chatId: "chat",
      contentDomain: "chat",
      generation: 1,
    },
  ],
  cuaPreviewStopSchema: [{ leaseId: id(3), workerId: "worker" }],
  cuaPreviewStoppedSchema: [
    { closed: true },
    { closed: true, activityPublicationFailed: true },
  ],
  cuaAgentAuthorityRequestSchema: [
    { binding: agentBinding("owner", Date.parse("2026-11-08T09:00:00.000Z")) },
  ],
  computerUseNativePreviewActionSchema: [
    { operation: "agent.sources.list" },
    { operation: "agent.observation.get", sourceId: id(4) },
    { operation: "session.close", sessionId: "session" },
  ],
  computerUseNativePreviewResultSchema: [list, capture],
  cuaSessionSchema: [session],
  cuaInputResultSchema: [
    {
      session,
      input: {
        method: "accessibility",
        activation: false,
        outcome: "dispatched",
      },
    },
  ],
  cuaClipboardResultSchema: [{ session, text: "Clipboard fixture" }],
  cuaInventorySchema: [{ targets: [session.target] }],
  cuaControlsResultSchema: [
    { session, inspection: { controls: [], truncated: false } },
  ],
  cuaSnapshotSchema: [{ session, image }],
  cuaAgentObservationSchema: [observation],
};
const name = process.argv[2];
assert.ok(computerUseHttpContractRoots.includes(name), "Unknown CUA HTTP root");
const schema = sourceContractSchema(name);
for (const sample of samples[name])
  assert.equal(
    schema.safeParse(sample).success,
    true,
    "Invalid positive fixture " + name,
  );
const rejected = {
  computerUseNativePreviewResultSchema: [
    { ...list, data: { sources: [observation.source, observation.source] } },
  ],
  cuaAgentObservationSchema: [
    { ...observation, source: { ...observation.source, cursorRevision: 1 } },
    { ...observation, image: { ...image, byteCount: 2_621_441 } },
    { ...observation, image: { ...image, width: 801 } },
  ],
};
const invalid = (rejected[name] ?? []).map((input) => {
  const result = outcome(schema, input);
  assert.ok(result.issues);
  return { input, outcome: result };
});
console.log(
  JSON.stringify({ cases: [...vectorCases(name, samples[name]), ...invalid] }),
);
