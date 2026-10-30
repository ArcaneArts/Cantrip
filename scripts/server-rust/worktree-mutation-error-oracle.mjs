import { WorktreeCreateMutationError } from "../../cantrip_server/src/worktrees/coordinator.ts";

const cases = [];
for (const outcome of ["notStarted", "committed", "rolledBack", "partial"])
  for (const message of ["Controlled failure.", "x".repeat(1999) + "😀"]) {
    const input = {
      outcome,
      project: "project",
      worktree: outcome === "notStarted" ? null : "tree",
      message,
      retryable: outcome !== "notStarted",
    };
    const error = new WorktreeCreateMutationError(
      input.outcome,
      input.project,
      input.worktree,
      input.message,
      input.retryable,
    );
    cases.push({ input, failure: error.failure });
  }
console.log(JSON.stringify(cases));
