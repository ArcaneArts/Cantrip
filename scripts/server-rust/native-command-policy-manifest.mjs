// Development export; the native server embeds the resulting data.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { parse } from "@babel/parser";
import { fileURLToPath } from "node:url";
import { format, resolveConfig } from "prettier";
import {
  managedNativeMethods,
  managedNativeServerRequests,
} from "../../packages/protocol/dist/index.js";

const source = parse(
  await readFile(
    new URL(
      "../../cantrip_server/src/db/repository/native-commands.ts",
      import.meta.url,
    ),
    "utf8",
  ),
  { sourceType: "module", plugins: ["typescript"] },
);
const names = new Set([
  "settingKeys",
  "defaultKeys",
  "activeMutations",
  "scopedMutations",
  "sessionDiscoveryMethods",
]);
const sets = {};
for (const statement of source.program.body) {
  if (statement.type !== "VariableDeclaration") continue;
  for (const node of statement.declarations) {
    if (node.id.type !== "Identifier" || !names.has(node.id.name)) continue;
    const value = node.init;
    assert.ok(
      value?.type === "NewExpression" &&
        value.callee.type === "Identifier" &&
        value.callee.name === "Set",
    );
    const entries = value.arguments?.[0];
    assert.ok(entries?.type === "ArrayExpression");
    sets[node.id.name] = entries.elements.map((entry) => {
      assert.equal(entry?.type, "StringLiteral");
      return entry.value;
    });
  }
}
assert.deepEqual(Object.keys(sets).sort(), [...names].sort());
const manifest = {
  methods: Object.fromEntries(managedNativeMethods),
  serverRequests: [...managedNativeServerRequests],
  sets,
};
const destination = new URL(
  "../../cantrip_server_rs/contracts/native-command-policy.json",
  import.meta.url,
);
if (process.argv.includes("--check"))
  assert.deepEqual(JSON.parse(await readFile(destination, "utf8")), manifest);
else
  await writeFile(
    destination,
    await format(JSON.stringify(manifest), {
      ...(await resolveConfig(fileURLToPath(destination))),
      filepath: fileURLToPath(destination),
    }),
  );
console.log(
  JSON.stringify({
    methods: managedNativeMethods.size,
    serverRequests: managedNativeServerRequests.size,
    sets: names.size,
  }),
);
