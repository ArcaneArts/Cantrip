import {
  chatPlanOpaqueStateSchema,
  chatMessageOpaqueContentSchema,
  taskMessageOpaqueContentSchema,
} from "../../packages/protocol/dist/index.js";
import { retainedPrompt } from "./native-settlement-fixtures.mjs";
export const eventPlan = chatPlanOpaqueStateSchema.parse({
  classification: { hasQuestion: true },
  protectedContent: retainedPrompt().protectedContent,
});
export const eventMessage = chatMessageOpaqueContentSchema.parse(
  retainedPrompt().pendingMessage,
);
export const taskEventMessage = taskMessageOpaqueContentSchema.parse(
  retainedPrompt().pendingMessage,
);
