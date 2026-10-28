// Development-only generation; production embeds the checked-in Rust tables.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  readFile,
  readdir,
  writeFile,
  cp,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const option = process.argv.indexOf("--generator");
const generator = option < 0 ? "icu4x-datagen" : process.argv[option + 1];
const root = fileURLToPath(new URL("../../", import.meta.url));
const target = path.join(
  root,
  "cantrip_server_rs/third-party/icu_collator_data",
);
const temporary = await mkdtemp(path.join(tmpdir(), "cantrip-collation-data-"));
const output = path.join(temporary, "data");
try {
  execFileSync(
    generator,
    [
      "--format",
      "baked",
      "--markers",
      "CollationRootV1",
      "CollationTailoringV1",
      "CollationDiacriticsV1",
      "CollationJamoV1",
      "CollationMetadataV1",
      "CollationSpecialPrimariesV1",
      "CollationReorderingV1",
      "--locales",
      "full",
      "--collation-root-han",
      "unihan",
      "--cldr-tag",
      "48.0.0",
      "--icuexport-tag",
      "release-78.2",
      "--out",
      output,
    ],
    { stdio: "inherit" },
  );
  const modulePath = path.join(output, "mod.rs");
  let module = await readFile(modulePath, "utf8");
  const prefix = module.match(
    /^\/\/ @generated\n((?:include\s*!\s*\(\s*"[^"]+"\s*\)\s*;\s*)+)/,
  );
  if (!prefix)
    throw new Error("Unable to parse generated collation module includes");
  const includes = [
    ...prefix[1].matchAll(/include\s*!\s*\(\s*"([^"]+)"\s*\)\s*;/g),
  ];
  const canonical = includes
    .map((match) => match[1])
    .sort()
    .map((name) => `include!("${name}");`)
    .join("\n");
  module =
    "// @generated\n" + canonical + "\n" + module.slice(prefix[0].length);
  const callPattern =
    /(impl_collation_[a-z0-9_]+)\s*!\s*\(\s*\$\s*provider\s*\)\s*;/g;
  const calls = [...module.matchAll(callPattern)]
    .map((match) => match[1])
    .sort();
  let inserted = false;
  module = module.replace(callPattern, () => {
    if (inserted) return "";
    inserted = true;
    return calls.map((name) => `${name}!($provider);`).join(" ");
  });
  await writeFile(modulePath, module);
  const checksums = {};
  for (const name of (await readdir(output)).sort())
    checksums[name] = createHash("sha256")
      .update(await readFile(path.join(output, name)))
      .digest("hex");
  await cp(output, path.join(target, "data"), { recursive: true });
  await writeFile(
    path.join(target, "generated-sha256.json"),
    JSON.stringify(checksums, null, 2) + "\n",
  );
  console.log(
    `Generated ${Object.keys(checksums).length} ICU 78.2 / CLDR 48.0 full-Unihan collation files`,
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
