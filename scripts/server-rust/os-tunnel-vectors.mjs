import * as protocol from "../../packages/protocol/dist/index.js";
import { osDispatchFixtures } from "./cantrip-os-dispatch-fixtures.mjs";
import commands from "./worker-command-fixtures.json" with { type: "json" };

const execution = osDispatchFixtures().cantripOsExecutionSchema[0];
const source = Object.fromEntries(
  [
    "bindingId",
    "worktreeId",
    "bindingGeneration",
    "attachmentGeneration",
    "runtimeGeneration",
  ].map((key) => [key, execution.scope[key]]),
);
const id = "55555555-5555-4555-8555-555555555555";
const record = {
  operationId: id,
  revision: 1,
  protectedContent: {
    formatVersion: 1,
    domain: "tunnel-content",
    keyRevision: 1,
    envelope: {
      version: 1,
      algorithm: "AES-256-GCM",
      keyRevision: 1,
      nonce: "AAAAAAAAAAAAAAAA",
      ciphertext: "AAAAAAAAAAAAAAAAAAAAAA",
    },
  },
};
const input = {
  id,
  projectId: execution.scope.projectId,
  protocolHint: "tcp",
  destination: {
    kind: "worker-adapter",
    adapter: "cantrip-os",
    workerId: execution.scope.workerId,
    resourceId: id,
  },
  osSource: source,
  protectedRecord: record,
};
const cases = [];
function add(schema, value) {
  const input = JSON.parse(JSON.stringify(value));
  const result = protocol[schema].safeParse(input);
  cases.push({
    schema,
    input,
    outcome: result.success
      ? { ok: result.data }
      : { issues: result.error.issues },
  });
}
for (const value of [
  input,
  { ...input, projectId: null },
  { ...input, osSource: undefined },
  {
    ...input,
    destination: {
      ...input.destination,
      resourceId: "66666666-6666-4666-8666-666666666666",
    },
  },
  {
    ...input,
    destination: { kind: "worker-tcp", workerId: execution.scope.workerId },
  },
  { ...input, osSource: { ...source, desktopGeneration: "a".repeat(64) } },
  { ...input, protectedRecord: { ...record, revision: 2 } },
  {
    ...input,
    protectedRecord: {
      ...record,
      operationId: "66666666-6666-4666-8666-666666666666",
    },
  },
])
  add("tunnelUserWireCreateSchema", value);
const command = {
  type: "surface.tunnel.os-prepare",
  serverId: "fixture-server",
  projectId: execution.scope.projectId,
  tunnelId: id,
  attachmentId: id,
  grantId: id,
  expiresAt: "2027-01-01T00:00:00Z",
  expectedIdentity: null,
  protectedRecord: record,
  osExecution: execution,
};
const envelope = commands.commands.find(
  (item) => item.type === "chat.turn",
).input;
add("workerRequestEnvelopeSchema", { ...envelope, command });
add("workerRequestEnvelopeSchema", {
  ...envelope,
  command: { ...command, projectId: "another-project" },
});
add("workerRequestEnvelopeSchema", {
  ...envelope,
  command: { ...command, expectedIdentity: "wrong" },
});
add("tunnelOsPrepareResultSchema", { identity: "a".repeat(64) });
add("tunnelOsPrepareResultSchema", { identity: "A".repeat(64) });
add("tunnelOsPrepareResultSchema", {
  identity: "a".repeat(64),
  transport: "private",
});
process.stdout.write(JSON.stringify(cases));
