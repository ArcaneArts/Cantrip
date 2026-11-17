// Export the actual worker-local schemas; no production JavaScript dependency.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { buildContractManifest } from "../server-rust/contracts.mjs";
import * as journal from "../../cantrip_worker/src/native-history-source-journal.ts";
import * as native from "../../cantrip_worker/src/codex/native-history.ts";

import * as state from "../../cantrip_worker/src/native-history-state.ts";
import { nativeInitialTurnSettingsSchema } from "../../packages/protocol/dist/index.js";

import * as outbox from "../../cantrip_worker/src/native-history-outbox.ts";
import * as mutation from "../../cantrip_worker/src/native-history-outbox-mutations.ts";
import { nativeHistoryOutboxBaselineSchema } from "../../cantrip_worker/src/native-history-outbox-baseline.ts";
import {
  nativeHistoryOutboxRecordSchema,
  historySequenceSchema,
} from "../../cantrip_worker/src/native-history-outbox-record.ts";

export const schemas = {
  nativeHistorySourceScopeSchema: journal.scopeSchema,
  nativeHistorySourceManifestSchema: journal.manifestSchema,
  nativeHistorySourceRecordSchema: journal.recordSchema,
  nativeHistorySourceFrameSchema: journal.sourceSchema,
  historySourceOrdinalSchema: journal.historySourceOrdinalSchema,
  historySourcePositiveSchema: journal.historySourcePositiveSchema,
  historySourcePageLimitSchema: journal.historySourcePageLimitSchema,
  codexNativeHistorySnapshotSchema: native.nativeHistorySchema,
  codexNativeHistoryCursorSchema: native.nativeHistoryCursorSchema,
  nativeHistoryStateSchema: state.nativeHistoryStateSchema,
  nativeHistoryInitialTurnSettingsSchema: nativeInitialTurnSettingsSchema,
  nativeHistoryOutboxScopeSchema: outbox.nativeHistoryOutboxScopeSchema,
  nativeHistoryOutboxManifestSchema: outbox.nativeHistoryOutboxManifestSchema,
  nativeHistoryOutboxMutationHeaderSchema:
    mutation.nativeHistoryOutboxMutationHeaderSchema,
  nativeHistoryOutboxMutationPayloadSchema:
    mutation.nativeHistoryOutboxMutationPayloadSchema,
  nativeHistoryOutboxBaselineSchema,
  nativeHistoryOutboxRecordSchema,
  nativeHistoryOutboxSequenceSchema: historySequenceSchema,
};
const refinements = new Map([
  [native.nativeHistorySequenceSchema, "history-source-native-sequence"],
  [
    native.historyMetadataSchema.shape.live.unwrap(),
    "history-source-live-boundary",
  ],
]);
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = buildContractManifest(Object.keys(schemas), {
    schemas,
    refinements,
    recursiveJson: new Set([
      state.nativeHistoryStateObjectSchema._zod.def.valueType,
    ]),
  });
  await writeFile(
    new URL(
      "../../crates/cantrip-protocol/contracts/native-history-source.json",
      import.meta.url,
    ),
    await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
  );
  console.log(
    `${Object.keys(manifest.roots).length} native history roots / ${manifest.nodes.length} nodes`,
  );
}
