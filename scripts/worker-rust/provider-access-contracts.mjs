// Export the worker-only lease schema from the shared TypeScript source.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { providerAccessTokenLeaseSchema } from "../../packages/protocol/dist/index.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = {
  workerPortableProviderLeaseSchema: providerAccessTokenLeaseSchema,
};
const manifest = buildContractManifest(Object.keys(schemas), { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-provider-access.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
