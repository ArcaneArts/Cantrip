// Expectations execute the actual protocol, including UTF-16 trim/length rules.
import * as p from "../../packages/protocol/dist/index.js";
import { vectorCases, outcome } from "./security-oracle.mjs";
import { heartbeat } from "./security-fixtures.mjs";
const source = {
  projectReplicaId: "source",
  projectId: "11111111-1111-4111-8111-000000000001",
  nameWithOwner: "owner/repository",
  displayPath: "/project",
};
const worker = {
  ...heartbeat,
  online: true,
  lastSeenAt: "2026-01-01T00:00:00.000Z",
  runtimeName: "Runtime worker",
  internal: false,
  editable: true,
  removable: true,
  credentialCount: 3,
  activeCredentialCount: 2,
  sources: [source],
};
const samples = {
  workerManagementSourceSchema: [source],
  workerManagementSummarySchema: [worker],
  workerManagementListSchema: [[worker]],
  workerUpdateSchema: [{ name: " Worker " }],
  workerRestartAcknowledgementSchema: [{ restarting: true }],
  workerRestartResultSchema: [{ workerId: "worker", status: "restarting" }],
};
const name = process.argv[2],
  cases = [...vectorCases(name, samples[name])];
function add(input) {
  input = JSON.parse(JSON.stringify(input));
  const result = outcome(p[name], input);
  cases.push({
    input,
    outcome: result,
    ...(result.issues
      ? { errorMessage: p[name].safeParse(input).error.message }
      : {}),
  });
}
if (name === "workerUpdateSchema")
  for (const value of [
    "",
    " ",
    "\ufeff Worker\u00a0",
    "\u200b",
    "a".repeat(120),
    "a".repeat(121),
    "😀".repeat(60),
    "😀".repeat(61),
    "\ud800",
    "a".repeat(119) + "\ud800",
    null,
    0,
    false,
    [],
    {},
    "\u2028\u2029",
  ]) {
    add({ name: value });
    add({ name: value, unknown: "stripped" });
  }
if (name === "workerManagementSourceSchema") {
  add({ ...source, projectReplicaId: undefined });
  add({ ...source, projectReplicaId: null });
}
console.log(JSON.stringify({ cases }));
