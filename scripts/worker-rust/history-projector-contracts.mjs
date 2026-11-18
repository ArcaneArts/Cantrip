// Actual worker-local projector state and authenticated recovery content.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import * as protocol from "../../packages/protocol/dist/index.js";
import { nativeHistoryProjectorStateSchema } from "../../cantrip_worker/src/native-history-projector.ts";
import { nativeHistoryProjectorTurnContentSchema } from "../../cantrip_worker/src/native-history-projector-bootstrap.ts";
import { nativeHistoryStateObjectSchema } from "../../cantrip_worker/src/native-history-state.ts";
import { nativeHistorySequenceSchema } from "../../cantrip_worker/src/codex/native-history.ts";
import { buildContractManifest } from "../server-rust/contracts.mjs";
const schemas = {
  nativeHistoryProjectorStateSchema,
  nativeHistoryProjectorTurnContentSchema,
  historyProjectorObjectSchema: nativeHistoryStateObjectSchema,
  historyProjectorTurnStatusSchema:
    protocol.nativeHistoryTurnSchema.shape.status,
};
const manifest = buildContractManifest(Object.keys(schemas), {
  schemas,
  refinements: new Map([
    [nativeHistorySequenceSchema, "history-source-native-sequence"],
  ]),
  recursiveJson: new Set([nativeHistoryStateObjectSchema._zod.def.valueType]),
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/native-history-projector.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
console.log(
  `${Object.keys(schemas).length} projector roots / ${manifest.nodes.length} nodes`,
);
