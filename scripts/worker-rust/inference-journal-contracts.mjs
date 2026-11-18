// Export current worker journal contracts; no JavaScript runtime dependency.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { buildContractManifest } from "../server-rust/contracts.mjs";
import { workerInferenceJournalSnapshotSchema } from "../../cantrip_worker/src/inference-journal.ts";
import {
  inferenceJournalIdentitySchema,
  inferenceJournalRecordSchema,
} from "../../packages/protocol/dist/index.js";
export const schemas = {
  workerInferenceJournalSnapshotSchema,
  workerInferenceJournalIdentitySchema: inferenceJournalIdentitySchema,
  workerInferenceJournalRecordSchema: inferenceJournalRecordSchema,
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = buildContractManifest(Object.keys(schemas), { schemas });
  await writeFile(
    new URL(
      "../../crates/cantrip-protocol/contracts/worker-inference-journal.json",
      import.meta.url,
    ),
    await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
  );
  console.log(
    `${Object.keys(manifest.roots).length} inference journal roots / ${manifest.nodes.length} nodes`,
  );
}
