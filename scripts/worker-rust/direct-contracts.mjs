import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import {
  directBrokerInitializeSchema,
  directBrokerReadySchema,
} from "../../packages/protocol/dist/direct-data-plane.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = { directBrokerInitializeSchema, directBrokerReadySchema };
const manifest = buildContractManifest(Object.keys(schemas), { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-direct-broker.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
