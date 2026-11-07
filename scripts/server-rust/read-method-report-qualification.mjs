// Recheck complete cells from retained reports without constructing giant diffs.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { readCases } from "./read-method-fixtures.mjs";
const [reportPath, profile, outputPath] = process.argv.slice(2);
const input = await readFile(reportPath);
const report = JSON.parse(input);
const cell = report.profiles.find((cell) => cell.profile === profile);
assert.ok(cell, `Missing ${profile}`);
assert.equal(cell.runtimes.length, 2);
const [source, native] = cell.runtimes;
assert.equal(source.kind, "node");
assert.equal(native.kind, "rust");
assert.equal(source.passed, true);
assert.equal(native.passed, true);
assert.deepEqual(native.authentication, source.authentication);
const expected = readCases().flatMap((entry) =>
  ["GET", "HEAD"].map((method) => ({
    name: entry.name,
    method,
    url: entry.url,
  })),
);
assert.equal(source.http.length, expected.length);
assert.equal(native.http.length, source.http.length);
assert.equal(source.sql.length, source.http.length);
assert.equal(native.sql.length, source.sql.length);
function canonical(entry) {
  const { rawStatePath, ...value } = structuredClone(entry);
  for (const snapshot of [value.before, value.after])
    for (const rows of Object.values(snapshot)) {
      const identity = (row) =>
        String(
          row.id ??
            row.operation_id ??
            row.workspace_id ??
            row.instance_id ??
            row.chat_id ??
            JSON.stringify(row),
        );
      rows.sort((a, b) => identity(a).localeCompare(identity(b)));
    }
  return value;
}
for (let index = 0; index < source.http.length; index++) {
  assert.deepEqual(
    {
      name: source.http[index].name,
      method: source.http[index].method,
      url: source.http[index].url,
    },
    expected[index],
    `${profile} expected scenario ${index}`,
  );
  assert.deepEqual(
    native.http[index],
    source.http[index],
    `${profile} HTTP ${index}`,
  );
  assert.deepEqual(
    canonical(native.sql[index]),
    canonical(source.sql[index]),
    `${profile} SQL ${index}`,
  );
}
const result = {
  database: report.database,
  profile,
  reportPath,
  reportSha256: createHash("sha256").update(input).digest("hex"),
  pairedReadHTTP: source.http.length,
  pairedCompleteSQL: source.sql.length,
  selectedTables: Object.keys(source.sql[0].before).length,
  nativeArtifactSha256: report.executableSha256,
  completeCellIndependentlyQualified: true,
  originalReportPassed: report.passed,
  originalReportFailure: report.failure ?? null,
  scope:
    "Every retained HTTP and complete SQL entry in this cell is compared; failed or incomplete other profiles are not counted.",
};
await writeFile(outputPath, JSON.stringify(result, null, 2) + "\n");
console.log(
  JSON.stringify({
    database: result.database,
    profile,
    pairedReadHTTP: result.pairedReadHTTP,
    pairedCompleteSQL: result.pairedCompleteSQL,
    qualified: true,
  }),
);
