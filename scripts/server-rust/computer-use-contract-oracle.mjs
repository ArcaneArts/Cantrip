import assert from "node:assert/strict";
import {
  sourceContractSchema,
  computerUseHttpContractRoots,
} from "./contracts.mjs";
import { vectorCases } from "./security-oracle.mjs";
import { id, input, opaque } from "./computer-use-http-fixtures.mjs";
import {
  activityEvent,
  agentBinding,
} from "./computer-use-http-additional.mjs";

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
};
const name = process.argv[2];
assert.ok(computerUseHttpContractRoots.includes(name), "Unknown CUA HTTP root");
for (const sample of samples[name])
  assert.equal(
    sourceContractSchema(name).safeParse(sample).success,
    true,
    "Invalid positive fixture " + name,
  );
console.log(JSON.stringify({ cases: [...vectorCases(name, samples[name])] }));
