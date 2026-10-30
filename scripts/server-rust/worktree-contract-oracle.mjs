import * as protocol from "../../packages/protocol/dist/index.js";
import { outcome } from "./security-oracle.mjs";

const target = { kind: "worktree", projectId: "project", worktreeId: "tree" };
const schema = protocol.worktreeCreateMutationFailureSchema;
const inputs = [null, {}, { unknown: true }];
for (const state of ["notStarted", "committed", "rolledBack", "partial"])
  for (const code of ["not-started", "committed", "rolled-back", "partial"])
    for (const recovery of [null, target])
      inputs.push({
        code: `worktree-create-${code}`,
        error: "Failure",
        mutation: { outcome: state, retryable: true, target: recovery },
      });
const base = {
  code: "worktree-create-partial",
  error: "Failure",
  mutation: { outcome: "partial", retryable: true, target },
};
for (const error of [
  "",
  "😀".repeat(1000),
  "😀".repeat(1001),
  "x".repeat(1999) + "\ud83d",
])
  inputs.push({ ...base, error });
inputs.push(
  { ...base, unknown: true },
  { ...base, mutation: { ...base.mutation, unknown: true } },
  {
    ...base,
    mutation: {
      ...base.mutation,
      target: { ...target, projectId: "x".repeat(201) },
    },
  },
);
console.log(
  JSON.stringify({
    schema: "worktreeCreateMutationFailureSchema",
    cases: inputs.map((input) => ({
      input,
      outcome: outcome(schema, input),
      ...(!schema.safeParse(input).success
        ? { errorMessage: schema.safeParse(input).error.message }
        : {}),
    })),
  }),
);
