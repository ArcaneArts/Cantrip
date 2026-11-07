import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { readServerSchemaSourceCorpus } from "./server-schema-source-corpus.mjs";

test("inventories every table exported by the actual Drizzle schema", async () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const sources = await readServerSchemaSourceCorpus(root);
  const declared = sources.flatMap(({ sourceText }) =>
    [
      ...sourceText.matchAll(
        /export const ([A-Za-z][A-Za-z0-9_]*)\s*=\s*pgTable\(/gu,
      ),
    ].map((match) => match[1]),
  );
  const schema = await tsImport(
    "../cantrip_server/src/db/schema.ts",
    import.meta.url,
  );
  const require = createRequire(
    new URL("../cantrip_server/package.json", import.meta.url),
  );
  const { isTable } = require("drizzle-orm");
  const actual = Object.entries(schema)
    .filter(([, value]) => isTable(value))
    .map(([name]) => name);
  assert.deepEqual(declared.sort(), actual.sort());
  for (const name of [
    "cantripOsDesktopOperations",
    "cantripOsWorkspaceOperations",
    "cantripOsSystemOperations",
    "inferenceResourceRevocations",
  ])
    assert.ok(declared.includes(name), name);
});
