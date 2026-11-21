// Generate Rust storage validation from the Node worker's existing disk format.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  nativeSuspensionSourceSchema,
  nativeSuspensionStorageScopeSchema,
  nativeSuspensionStorageRecordSchema,
  nativeSuspensionStorageSnapshotSchema,
} from "../../tests/reference-node-worker/src/native-suspension-store.ts";
import { workerTurnContinuationSchema } from "../../tests/reference-node-worker/src/codex/worker-turn-continuation.ts";
import { taskWorkerContinuationSchema } from "../../tests/reference-node-worker/src/task-worker-continuation.ts";
import { taskEventSealerStateSchema } from "../../tests/reference-node-worker/src/task-event-sealer-state.ts";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = {
  nativeSuspensionSourceSchema,
  nativeSuspensionStorageScopeSchema,
  nativeSuspensionStorageRecordSchema,
  nativeSuspensionStorageSnapshotSchema,
};
const refinements = new Map([
  [nativeSuspensionSourceSchema, "suspension-storage-source"],
  [nativeSuspensionStorageRecordSchema, "suspension-storage-record"],
  [nativeSuspensionStorageSnapshotSchema, "suspension-storage-snapshot"],
  [workerTurnContinuationSchema, "suspension-worker-continuation"],
  [taskWorkerContinuationSchema.options[0], "suspension-round-continuation"],
  [taskWorkerContinuationSchema.options[1], "suspension-goal-continuation"],
  [taskEventSealerStateSchema, "suspension-event-state"],
]);
const manifest = buildContractManifest(Object.keys(schemas), {
  schemas,
  refinements,
  recursiveJson: new Set([
    workerTurnContinuationSchema.shape.structuredOutputSchema.unwrap()._zod.def
      .valueType,
  ]),
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-suspension-storage.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
