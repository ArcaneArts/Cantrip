import { gitManagedOperationWorkerStateSchema } from "../../packages/protocol/dist/index.js";
import { buildGitOperationObservation } from "../../cantrip_worker/src/worktrees.ts";
import {
  settingsProject,
  settingsTree,
} from "./native-settings-http-fixture.mjs";
import { stamp } from "./project-target-state.mjs";

export const operationId = "99999999-9999-4999-8999-999999999999";
export const sourcePath = "ctrr_" + "s".repeat(43);
export const worktreePath = "ctrr_" + "w".repeat(43);
export const context = {
  type: "rebase",
  originalHead: "a".repeat(40),
  sourceRef: "feature",
  sourceRevision: "b".repeat(40),
  targetRef: "main",
  targetRevision: "c".repeat(40),
  pendingCommits: ["b".repeat(40)],
  totalSteps: 1,
  checkpointRef: "refs/cantrip/checkpoints/observation",
};
export const completed = gitManagedOperationWorkerStateSchema.parse({
  ...context,
  state: "completed",
  currentHead: "c".repeat(40),
  currentStep: 1,
  pendingCommits: [],
  conflictedPaths: [],
  output: "inspected completion",
  pausedAction: null,
  status: {
    branch: "main",
    head: "c".repeat(40),
    upstream: null,
    ahead: 0,
    behind: 0,
    files: [],
    branches: [],
  },
});
export function observation(
  state = completed,
  conflicts = { files: [], truncated: false },
  changes = {},
) {
  return {
    ...buildGitOperationObservation({
      state,
      conflicts,
      observedAt: stamp,
      target: {
        projectId: settingsProject,
        worktreeId: settingsTree,
        sourcePath,
        worktreePath,
        operation: { id: operationId, context },
      },
    }),
    ...changes,
  };
}
