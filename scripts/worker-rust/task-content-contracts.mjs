// Generate the endpoint-only plaintext Task formats from the protocol package.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { boundedJsonObjectSchema } from "../../packages/protocol/dist/bounded-json.js";
import * as tasks from "../../packages/protocol/dist/tasks.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const names = [
  "taskProtectedClassificationSchema",
  "taskProtectedContentSchema",
  "encryptedTaskProtectedContentSchema",
  "taskPlanningRoundProtectedClassificationSchema",
  "taskPlanningRoundProtectedContentSchema",
  "encryptedTaskPlanningRoundProtectedContentSchema",
  "taskMessageProtectedClassificationSchema",
  "taskMessageProtectedContentSchema",
  "encryptedTaskMessageProtectedContentSchema",
  "taskGoalObjectiveProtectedClassificationSchema",
  "taskGoalObjectiveProtectedContentSchema",
  "encryptedTaskGoalObjectiveSchema",
  "taskPlannerResultSchema",
  "taskFinalizerResultSchema",
];
const schemas = {
  ...Object.fromEntries(names.map((name) => [name, tasks[name]])),
  boundedJsonObjectSchema,
};
const refinements = new Map([
  [tasks.taskQuestionSchema, "task-content-question"],
  [
    tasks.taskFinalizerResultSchema.shape.goalPrompt,
    "task-content-goal-prompt",
  ],
  [tasks.taskQuestionListSchema, "task-content-questions"],
  [tasks.taskQuestionAnswerSchema, "task-content-answer"],
  [tasks.taskQuestionAnswerListSchema, "task-content-answers"],
  [tasks.taskProtectedContentSchema, "task-content-classification"],
  [
    tasks.taskPlanningRoundProtectedContentSchema,
    "task-round-content-classification",
  ],
  [
    tasks.taskMessageProtectedContentSchema,
    "task-message-content-classification",
  ],
  [
    tasks.taskMessageProtectedClassificationSchema.shape.attachmentIds,
    "worker-wire-attachment-ids",
  ],
  [
    tasks.encryptedTaskMessageProtectedContentSchema,
    "worker-wire-task-envelope",
  ],
]);
const manifest = buildContractManifest(Object.keys(schemas), {
  schemas,
  refinements,
  recursiveJson: new Set([
    tasks.taskMessageProtectedContentSchema.shape.content.element,
  ]),
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-task-content.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);

await writeFile(
  new URL(
    "../../cantrip_worker/src/codex/turn/task/model-output.json",
    import.meta.url,
  ),
  await format(
    JSON.stringify({
      planner: tasks.taskPlannerOutputJsonSchema,
      finalizer: tasks.taskFinalizerOutputJsonSchema,
      nativeGoalObjectiveLimit: tasks.TASK_NATIVE_GOAL_OBJECTIVE_LIMIT,
    }),
    { parser: "json", tabWidth: 2 },
  ),
);
