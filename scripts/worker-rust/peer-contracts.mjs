import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { workerLinkPeerHandshakeSchema } from "../../packages/protocol/dist/worker-link.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const schemas = { workerLinkPeerHandshakeSchema };
const manifest = buildContractManifest(Object.keys(schemas), { schemas });
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-link-peer.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
