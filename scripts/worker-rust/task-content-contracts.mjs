// Generate the endpoint-only plaintext Task formats from the protocol package.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
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
];
const schemas = Object.fromEntries(names.map((name) => [name, tasks[name]]));
const refinements = new Map([
  [tasks.taskQuestionSchema, "task-content-question"],
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
const manifest = buildContractManifest(names, {
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
