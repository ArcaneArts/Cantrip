// Actual shared/worker-local plaintext contracts; development generation only.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { createRequire } from "node:module";
import * as protocol from "../../packages/protocol/dist/index.js";
import * as communication from "../../packages/protocol/dist/communication-content.js";
import * as state from "../../tests/reference-node-worker/src/native-history-state.ts";
import { nativeHistorySequenceSchema } from "../../tests/reference-node-worker/src/codex/native-history.ts";
import { nativeHistoryUsageSourceSchema } from "../../tests/reference-node-worker/src/native-history-usage.ts";
import { buildContractManifest } from "../server-rust/contracts.mjs";
const names = [
  "chatMessageContentSchema",
  "chatMessageProtectedClassificationSchema",
  "chatMessageProtectedContentSchema",
  "encryptedChatMessageProtectedContentSchema",
  "queuedPromptProtectedClassificationSchema",
  "queuedPromptProtectedContentSchema",
  "encryptedQueuedPromptProtectedContentSchema",
  "chatPlanProtectedClassificationSchema",
  "chatPlanProtectedContentSchema",
  "encryptedChatPlanProtectedContentSchema",
  "chatComposerDraftProtectedContentSchema",
  "encryptedChatComposerDraftProtectedContentSchema",
  "interactionProtectedClassificationSchema",
  "interactionRequestProtectedContentSchema",
  "encryptedInteractionRequestContentSchema",
  "interactionResponseProtectedContentSchema",
  "encryptedInteractionResponseContentSchema",
  "nativeHistoryItemEvidenceSchema",
  "nativeHistoryItemIdentitySchema",
  "nativeHistoryTurnSchema",
  "nativeHistoryUsageSchema",
  "nativeResponseUsageCountsSchema",
];
const { z } = createRequire(
  new URL("../../packages/protocol/package.json", import.meta.url),
)("zod");
const historyContentJsonSchema = z.json();
const schemas = {
  ...Object.fromEntries(
    names.map((name) => [name, protocol[name] ?? communication[name]]),
  ),
  nativeHistoryStateItemSchema: state.nativeHistoryStateItemSchema,
  nativeHistoryTurnHeaderSchema: protocol.nativeHistoryTurnSchema.omit({
    metadata: true,
  }),
  nativeHistoryUsageSourceSchema,
  historyContentJsonSchema,
};
const refinements = new Map([
  [nativeHistorySequenceSchema, "history-source-native-sequence"],
  [communication.chatMessageProtectedContentSchema, "history-content-message"],
  [communication.chatPlanProtectedContentSchema, "history-content-plan"],
  [communication.queuedPromptProtectedContentSchema, "history-content-prompt"],
  [
    communication.encryptedQueuedPromptProtectedContentSchema,
    "worker-wire-communication-envelope",
  ],
]);
const manifest = buildContractManifest(Object.keys(schemas), {
  schemas,
  refinements,
  recursiveJson: new Set([
    historyContentJsonSchema,
    state.nativeHistoryStateObjectSchema._zod.def.valueType,
    communication.chatMessageProtectedContentSchema.shape.content._zod.def
      .element,
    communication.interactionRequestProtectedContentSchema.shape.payload,
    communication.interactionResponseProtectedContentSchema.shape.response,
  ]),
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/native-history-content.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
console.log(
  `${Object.keys(manifest.roots).length} history content roots / ${manifest.nodes.length} nodes`,
);
