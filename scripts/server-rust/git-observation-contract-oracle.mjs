import { vectorCases } from "./security-oracle.mjs";
import { completed, operationId } from "./git-observation-fixtures.mjs";
import {
  settingsProject,
  settingsTree,
  settingsWorker,
} from "./native-settings-http-fixture.mjs";
import { stamp } from "./project-target-state.mjs";
const samples = {
  gitManagedOperationWorkerStateSchema: [
    completed,
    { ...completed, pausedAction: undefined },
    { ...completed, sourceRef: "branch-\ud800" },
  ],
  gitManagedOperationResponseSchema: [
    { operation: null },
    {
      operation: {
        ...completed,
        id: operationId,
        projectId: settingsProject,
        worktreeId: settingsTree,
        workerId: settingsWorker,
        error: null,
        createdAt: stamp,
        updatedAt: stamp,
        completedAt: stamp,
      },
    },
  ],
  gitConflictListSchema: [{ files: [], truncated: false }],
};
const schema = process.argv[2];
console.log(
  JSON.stringify({ cases: [...vectorCases(schema, samples[schema])] }),
);
