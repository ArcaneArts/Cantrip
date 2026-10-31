import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import {
  nativeExportHttpWrites,
  verifyNodeAfterNativeExport,
} from "./native-export-http-writes.mjs";
import { nativeExportInterruption } from "./native-export-interruption.mjs";
const { PGlite } = createRequire(
  import.meta.resolve("@electric-sql/pglite-tools/pg_dump"),
)("@electric-sql/pglite");

export async function nativeExportRoundtrip({
  run,
  snapshot,
  executable,
  environment,
  data,
  mode,
  root,
  expected,
  observe,
}) {
  const imported = await observe();
  assert.deepEqual(
    {
      tables: imported.tables,
      sequences: imported.sequences,
      probe: imported.probe,
    },
    expected,
  );
  const postWrites = await nativeExportHttpWrites({
    executable,
    environment,
    data,
    mode,
    root,
  });
  const written = await observe();
  expected = {
    tables: written.tables,
    sequences: written.sequences,
    probe: written.probe,
  };
  const reverseRoot = path.join(root, "native-reverse-" + mode);
  const destination = path.join(root, "native-export-" + mode + ".sql");
  const pgDump =
    process.env.CANTRIP_TEST_PG_DUMP_PATH ??
    path.join(
      process.env.CANTRIP_TEST_POSTGRES_BIN_DIR,
      "pg_dump" + (process.platform === "win32" ? ".exe" : ""),
    );
  const args = [
    "--data-dir",
    data,
    "--database",
    mode,
    "--migrate-only",
    "--export-sql",
    destination,
    "--pg-dump-path",
    pgDump,
  ];
  const interrupted = await nativeExportInterruption({
    executable,
    args,
    environment,
    root,
    mode,
    pgDump,
    observe,
  });
  const result = {
    interrupted,
    httpWrites: postWrites.result,
    exported: await run(executable, args, environment),
  };
  assert.equal(result.exported.code, 0, result.exported.stderr);
  const receipt = result.exported.records.find(
    (r) => r.event === "database.export.completed",
  )?.receipt;
  assert.ok(receipt);
  const sql = await readFile(destination);
  assert.equal(receipt.sha256, createHash("sha256").update(sql).digest("hex"));
  assert.equal(receipt.bytes, sql.length);
  assert.equal(receipt.psqlGuardsRemoved, 2);
  assert.equal(receipt.portableTransactionTimeout, true);
  if (process.platform !== "win32")
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
  let restored;
  try {
    await mkdir(reverseRoot, { recursive: true });
    restored = await PGlite.create(path.join(reverseRoot, "server-db"));
    await restored.exec(sql.toString("utf8"));
    result.reverse = await snapshot(restored);
    assert.deepEqual(
      result.reverse,
      expected,
      "reverse SQL transfer preserves every table/sequence/function and NULL kind",
    );
  } finally {
    await restored?.close();
  }
  result.existingDestination = await run(executable, args, environment);
  assert.notEqual(result.existingDestination.code, 0);
  assert.ok(
    result.existingDestination.stderr.includes("AlreadyExists"),
    result.existingDestination.stderr,
  );
  assert.deepEqual(
    await readFile(destination),
    sql,
    "failed publication preserves the existing export bytes",
  );
  const missingDestination = path.join(
    root,
    "missing-executable-" + mode + ".sql",
  );
  result.missingExecutable = await run(
    executable,
    [
      "--data-dir",
      data,
      "--database",
      mode,
      "--migrate-only",
      "--export-sql",
      missingDestination,
      "--pg-dump-path",
      path.join(root, "private-missing-pg-dump"),
    ],
    environment,
  );
  assert.notEqual(result.missingExecutable.code, 0);
  assert.equal(
    result.missingExecutable.stderr.includes("private-missing-pg-dump"),
    false,
  );
  await assert.rejects(readFile(missingDestination), { code: "ENOENT" });
  assert.deepEqual(
    (await readdir(root)).filter((name) => name.startsWith(".cantrip-export-")),
    [],
    "failed export removes only its private staging file",
  );
  const after = await observe();
  assert.deepEqual(
    after.tables,
    expected.tables,
    "export never refreshes identity or application rows",
  );
  assert.deepEqual(after.sequences, expected.sequences);
  assert.deepEqual(after.probe, expected.probe);
  result.sourceRetained = true;
  result.nodeAfterWrites = await verifyNodeAfterNativeExport({
    source: postWrites,
    reverseRoot,
    executable,
    root,
    mode,
  });
  return result;
}
