// Real WASM pg_dump, real SQL restore and a deliberate CLI error. No dump mock.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { inspect } from "node:util";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pgDumpRaw, removeDumpGuards } from "../database-transfer/pg-dump.mjs";

const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");
const at = process.argv.indexOf("--report");
const reportPath = at < 0 ? undefined : process.argv[at + 1];
const root = await mkdtemp(path.join(tmpdir(), "cantrip-export-literals-"));
const key = "CantripDumpGuardTest42";
const literal = [
  "before",
  "\\restrict " + key,
  "middle",
  "\\unrestrict " + key,
  "after é🦀",
].join("\n");
const report = { suite: "legacy-export-literal-and-error-boundaries", root };
let source, target, failure;
try {
  source = await PGlite.create(path.join(root, "source"));
  await source.exec("CREATE TABLE public.literal_probe(value text)");
  await source.query("INSERT INTO public.literal_probe VALUES($1)", [literal]);
  await source.exec(
    `CREATE FUNCTION public.literal_probe() RETURNS text LANGUAGE sql AS $body$ SELECT $literal$${literal}$literal$::text $body$`,
  );
  const searchPath = '"schema with space", public';
  await source.query("SELECT pg_catalog.set_config('search_path',$1,false)", [
    searchPath,
  ]);
  const before = (await source.query("SHOW SEARCH_PATH")).rows[0].search_path;
  const raw = await pgDumpRaw({
    pg: source,
    args: ["--no-owner", "--no-privileges", "--restrict-key=" + key],
  });
  const prepared = removeDumpGuards(raw);
  assert.equal(prepared.guardsRemoved, 2);
  assert.equal(
    (await source.query("SHOW SEARCH_PATH")).rows[0].search_path,
    before,
  );
  await writeFile(path.join(root, "raw.sql"), raw, { mode: 0o600 });
  await writeFile(path.join(root, "prepared.sql"), prepared.sql, {
    mode: 0o600,
  });
  target = await PGlite.create(path.join(root, "target"));
  await target.exec(prepared.sql);
  const restored = (
    await target.query(
      "SELECT value,public.literal_probe() AS function_value FROM public.literal_probe",
    )
  ).rows[0];
  assert.deepEqual(restored, { value: literal, function_value: literal });
  report.literalValuesPreserved = true;
  const privateValue = "private-export-error-fixture";
  let rejected;
  try {
    await pgDumpRaw({ pg: source, args: ["--" + privateValue] });
  } catch (error) {
    rejected = error;
  }
  assert.ok(rejected, "the actual pg_dump rejects its unsupported option");
  assert.equal(rejected.message.includes(privateValue), false);
  assert.equal(inspect(rejected).includes(privateValue), false);
  assert.ok(rejected.privateDiagnostics().stderr.includes(privateValue));
  assert.equal(
    (await source.query("SHOW SEARCH_PATH")).rows[0].search_path,
    before,
  );
  assert.equal(
    (
      await source.query(
        "SELECT count(*)::int AS count FROM public.literal_probe",
      )
    ).rows[0].count,
    1,
  );
  report.error = {
    message: rejected.message,
    privateDiagnosticsRetained: true,
    defaultRenderingRedacted: true,
  };
  report.sessionRetained = true;
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await target?.close();
  await source?.close();
  if (reportPath) {
    await mkdir(path.dirname(path.resolve(reportPath)), { recursive: true });
    await writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
  }
  if (!failure) await rm(root, { recursive: true, force: true });
}
// Emscripten cleanup can set process.exitCode. Throw only after it has finished.
if (failure) throw failure;
console.log(JSON.stringify({ suite: report.suite, passed: true }));
