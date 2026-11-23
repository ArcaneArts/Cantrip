// Export actual presentation contracts, independently of existing graph indices.
import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import * as protocol from "../../packages/protocol/dist/index.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";
const names = [
  "agentActivitySchema",
  "agentScopeSchema",
  "agentActivityRawEnvelopeSchema",
  "agentActivityRawRequestDocumentSchema",
  "agentActivityRawResponseDocumentSchema",
];
const schemas = Object.fromEntries(names.map((name) => [name, protocol[name]]));
const manifest = buildContractManifest(names, { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/native-history-render.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
console.log(
  `${names.length} native presentation roots / ${manifest.nodes.length} nodes`,
);
