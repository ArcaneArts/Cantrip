// Bounded streaming comparison against the production wire parser. By default,
// compare the same roots as wire_contracts; outgoing requests have their own
// exhaustive streaming command oracle.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { buildContractManifest } from "./contracts.mjs";
import { vectorCases } from "./security-oracle.mjs";
import { securityFixtures } from "./security-fixtures.mjs";

const { values } = parseArgs({
  options: {
    executable: { type: "string" },
    schemas: { type: "string" },
    report: { type: "string" },
  },
});
const schemas =
  values.schemas?.split(",") ??
  Object.keys(buildContractManifest().roots).filter(
    (name) => name !== "workerRequestEnvelopeSchema",
  );
const report = { completed: false, schemas: [], cases: 0 };
const child = spawn(values.executable ?? "wire-contract-fixture", [], {
  stdio: ["pipe", "pipe", "inherit"],
});
const closed = new Promise((resolve) => {
  child.once("error", (error) => resolve({ error: error.message }));
  child.once("close", (code, signal) => resolve({ code, signal }));
});
// Writes also receive their error through the callback below.
child.stdin.on("error", () => {});
const output = createInterface({ input: child.stdout });
const lines = output[Symbol.asyncIterator]();
let current;
try {
  await once(child, "spawn");
  for (const schema of schemas) {
    let count = 0;
    for (const item of vectorCases(schema)) {
      // The process oracle and Rust tests compare JSON-transported verdicts.
      const expected = JSON.parse(JSON.stringify(item));
      current = { schema, index: count, expected };
      await new Promise((resolve, reject) => {
        child.stdin.write(
          JSON.stringify({ schema, input: expected.input }) + "\n",
          (error) => (error ? reject(error) : resolve()),
        );
      });
      const line = await lines.next();
      assert.equal(
        line.done,
        false,
        `Native fixture ended at ${schema} case ${count}`,
      );
      const actual = JSON.parse(line.value);
      current.actual = actual;
      assert.deepEqual(
        actual.outcome,
        expected.outcome,
        `${schema} case ${count}`,
      );
      if (Object.hasOwn(expected, "errorMessage"))
        assert.equal(
          actual.errorMessage,
          expected.errorMessage,
          `${schema} case ${count} error message`,
        );
      count++;
      report.cases++;
    }
    report.schemas.push({
      schema,
      cases: count,
      fixtureSha256: createHash("sha256")
        .update(JSON.stringify(securityFixtures[schema]))
        .digest("hex"),
    });
    console.log(
      `${count} streaming Node/Rust comparisons matched for ${schema}`,
    );
  }
  child.stdin.end();
  assert.equal(
    (await lines.next()).done,
    true,
    "Unsolicited native fixture output",
  );
  const exit = await closed;
  assert.equal(exit.code, 0, `Native fixture exit: ${JSON.stringify(exit)}`);
  report.completed = true;
} catch (error) {
  report.failure = { ...current, message: error.message };
  throw error;
} finally {
  if (!report.completed) {
    child.stdin.destroy();
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  report.nativeExit = await closed;
  output.close();
  if (values.report) {
    await mkdir(path.dirname(path.resolve(values.report)), { recursive: true });
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  }
}
console.log(
  JSON.stringify({
    completed: report.completed,
    schemas: report.schemas.length,
    cases: report.cases,
  }),
);
