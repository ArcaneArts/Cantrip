import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { managedQueueNativeInputSchema } from "../../packages/protocol/dist/index.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = { managedQueueNativeInputSchema };
const manifest = buildContractManifest(Object.keys(schemas), { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-queue-input.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
