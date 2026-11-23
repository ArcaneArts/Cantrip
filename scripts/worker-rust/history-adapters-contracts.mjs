// Export actual worker-local contexts and the authoritative attachment summary.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { chatAttachmentSummarySchema } from "../../packages/protocol/dist/index.js";
import { nativeHistoryRetainedContextsSchema } from "../../tests/reference-node-worker/src/native-history-turn-context.ts";
import { buildContractManifest } from "../server-rust/contracts.mjs";
const schemas = {
  nativeHistoryRetainedContextsSchema,
  chatAttachmentSummarySchema,
};
const manifest = buildContractManifest(Object.keys(schemas), { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/native-history-adapters.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
console.log(
  `${Object.keys(schemas).length} history adapter roots / ${manifest.nodes.length} nodes`,
);
