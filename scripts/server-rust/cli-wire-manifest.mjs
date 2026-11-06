import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import { buildContractManifest, cliContractRoots } from "./contracts.mjs";
const manifest = buildContractManifest(cliContractRoots);
const destination = new URL(
  "../../cantrip_server_rs/contracts/cli.json",
  import.meta.url,
);
const output = await format(JSON.stringify(manifest), {
  ...(await resolveConfig(fileURLToPath(destination))),
  filepath: fileURLToPath(destination),
});
if (process.argv.includes("--write")) await writeFile(destination, output);
else assert.equal(await readFile(destination, "utf8"), output);
console.log(
  JSON.stringify({
    roots: Object.keys(manifest.roots).length,
    nodes: manifest.nodes.length,
  }),
);
