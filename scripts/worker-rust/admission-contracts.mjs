// Development export of authoritative provider/admission schemas.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { buildContractManifest } from "../server-rust/contracts.mjs";
import {
  providerInferenceConfigurationSchema,
  providerInferenceCatalogSchema,
  inferenceNativeExecutionSchema,
} from "../../packages/protocol/dist/index.js";
export const schemas = {
  workerAdmissionConfigurationSchema: providerInferenceConfigurationSchema,
  workerAdmissionCatalogSchema: providerInferenceCatalogSchema,
  workerAdmissionNativeExecutionSchema: inferenceNativeExecutionSchema,
};
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const manifest = buildContractManifest(Object.keys(schemas), { schemas });
  await writeFile(
    new URL(
      "../../crates/cantrip-protocol/contracts/worker-admission.json",
      import.meta.url,
    ),
    await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
  );
  console.log(
    `${Object.keys(manifest.roots).length} admission roots / ${manifest.nodes.length} nodes`,
  );
}
