import { writeFile } from "node:fs/promises";
import { format } from "prettier";
import { tunnelContentRecordSchema } from "../../packages/protocol/dist/tunnel-content.js";
import { buildContractManifest } from "../server-rust/contracts.mjs";

const manifest = buildContractManifest(["tunnelContentRecordSchema"], {
  schemas: { tunnelContentRecordSchema },
  refinements: new Map([
    [tunnelContentRecordSchema, "worker-command-tunnel-guest-source"],
  ]),
});
await writeFile(
  new URL(
    "../../crates/cantrip-protocol/contracts/worker-tunnel-content.json",
    import.meta.url,
  ),
  await format(JSON.stringify(manifest), { parser: "json", tabWidth: 2 }),
);
