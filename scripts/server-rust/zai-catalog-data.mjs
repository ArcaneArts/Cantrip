// Migration-time export of the actual built-in catalog. The native runtime
// embeds the resulting data and does not load JavaScript.
import { writeFile, readFile } from "node:fs/promises";
import { format, resolveConfig } from "prettier";
import {
  ZAI_CODEX_CATALOG_VERSION,
  ZAI_CODEX_CATALOG_SCOPE,
  ZAI_CODEX_CATALOG_SOURCE,
  ZAI_CODEX_MODELS,
} from "../../cantrip_server/src/models/zai-catalog.ts";

const target = new URL(
  "../../cantrip_server_rs/contracts/zai-catalog.json",
  import.meta.url,
);
const source =
  JSON.stringify(
    {
      version: ZAI_CODEX_CATALOG_VERSION,
      scope: ZAI_CODEX_CATALOG_SCOPE,
      source: ZAI_CODEX_CATALOG_SOURCE,
      models: ZAI_CODEX_MODELS,
    },
    null,
    2,
  ) + "\n";
const contents = await format(source, {
  ...(await resolveConfig(target.pathname)),
  parser: "json",
});
if (process.argv.includes("--check")) {
  if ((await readFile(target, "utf8")) !== contents)
    throw new Error(
      "Native built-in Z.ai catalog differs from the source server.",
    );
} else await writeFile(target, contents);
console.log(
  JSON.stringify({
    models: ZAI_CODEX_MODELS.length,
    version: ZAI_CODEX_CATALOG_VERSION,
    checked: process.argv.includes("--check"),
  }),
);
