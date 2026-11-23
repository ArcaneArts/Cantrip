// Compare the actual package command schemas without relying on the historical
// general worker-command inventory fixtures.
import * as protocol from "../../packages/protocol/dist/index.js";
import { outcome, vectorCases } from "./security-oracle.mjs";

const uuid = "11111111-1111-4111-8111-111111111111";
const scope = {
  ownerId: "owner",
  serverId: "server",
  workerId: "worker",
  instanceId: uuid,
  guestInstanceId: uuid,
  attachmentGeneration: uuid,
};
const target = {
  generation: uuid,
  expected: {
    guestInstanceId: uuid,
    ownerId: "owner",
    workerId: "worker",
    identityPath: "/var/lib/cantrip-os/instance.json",
  },
  bootId: uuid,
  initStart: "1",
  architecture: "arm64",
  containerId: "a".repeat(64),
};
const base = {
  scope,
  target,
  transport: { kind: "docker", container: "fixture" },
};
const operation = {
  kind: "request",
  requestId: "fixture",
  command: {
    ...base,
    type: "cantrip-os.packages.operation",
    mode: "execute",
    operationId: uuid,
    action: "upgrade",
    configuration: "preserve",
    packages: [
      {
        name: "cantrip-os-workspaces",
        version: "1.0.0",
        architecture: "arm64",
        sha256: "a".repeat(64),
        bytes: 123,
      },
    ],
  },
};
const status = {
  kind: "request",
  requestId: "fixture",
  command: { ...base, type: "cantrip-os.packages.status" },
};
let count = 0;
function emit(value) {
  const result = value.outcome.issues
    ? protocol.workerRequestEnvelopeSchema.safeParse(value.input)
    : null;
  console.log(
    JSON.stringify({
      schema: "workerRequestEnvelopeSchema",
      ...value,
      ...(result?.success === false
        ? { errorMessage: result.error.message }
        : {}),
    }),
  );
  count++;
}
for (const value of vectorCases("workerRequestEnvelopeSchema", [
  status,
  operation,
]))
  emit(value);
for (const mode of ["execute", "observe", "continue", "abandon"])
  for (const action of ["upgrade", "repair"])
    for (const configuration of ["preserve", "package-defaults"]) {
      const input = structuredClone(operation);
      Object.assign(input.command, { mode, action, configuration });
      emit({
        name: `${mode}/${action}/${configuration}`,
        input,
        outcome: outcome(protocol.workerRequestEnvelopeSchema, input),
      });
    }
for (const duplicate of [false, true]) {
  const input = structuredClone(operation);
  input.command.packages.push({
    ...input.command.packages[0],
    name: duplicate ? "cantrip-os-workspaces" : "cantrip-os-executor",
    sha256: "b".repeat(64),
  });
  emit({
    name: "duplicate package names " + duplicate,
    input,
    outcome: outcome(protocol.workerRequestEnvelopeSchema, input),
  });
}
console.log(JSON.stringify({ done: count }));
