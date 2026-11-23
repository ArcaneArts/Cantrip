import { vectorCases, outcome } from "./security-oracle.mjs";
import { sourceContractSchema } from "./contracts.mjs";
const samples = {
  projectPreferredWorkerUpdateSchema: [
    { workerId: null },
    { workerId: "worker" },
  ],
  projectWorktreePolicyUpdateSchema: [
    { policy: "direct" },
    { policy: "agent-managed" },
    { policy: "required-for-writes" },
  ],
  projectRemoveSchema: [
    {},
    { deleteLocalFiles: false },
    { deleteLocalFiles: true },
  ],
  computerUseAuthorityChangeSchema: [
    { ownerId: "owner", scope: { kind: "project", projectId: "project" } },
    { ownerId: "owner", scope: { kind: "chat", chatId: "chat" } },
    {
      ownerId: "owner",
      scope: { kind: "inherited-default", contextKind: "project" },
    },
  ],
};
const name = process.argv[2];
const schema = sourceContractSchema(name);
const cases = [...vectorCases(name, samples[name])];
for (const key of ["workerId", "policy", "deleteLocalFiles"])
  for (const value of [
    null,
    false,
    true,
    0,
    1,
    "",
    " ",
    "worker",
    "direct",
    "agent-managed",
    "required-for-writes",
    "false",
    "\ud800",
    [],
    {},
  ]) {
    const input = { [key]: value, unknown: "stripped" };
    const result = outcome(schema, input);
    cases.push({
      input,
      outcome: result,
      ...(result.issues
        ? { errorMessage: schema.safeParse(input).error.message }
        : {}),
    });
  }
console.log(JSON.stringify({ cases }));
