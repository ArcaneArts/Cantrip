// Actual production routing and Pino child-level behavior, including rejected
// requests. Every diagnostic is correlated to the response's real request ID.
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { postgresFixture } from "./postgres-fixture.mjs";
import { accountingProductionPeer } from "./accounting-production-peer.mjs";
import {
  targetPolicyCases,
  verifyTargetPolicy,
  targetPolicyNormalization,
} from "./http-target-policy-cases.mjs";
const { values } = parseArgs({ options: { report: { type: "string" } } });
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-http-policy-production-"),
);
console.error(JSON.stringify({ root }));
const report = { root, peers: [], completeReplacement: false };
report.normalization = targetPolicyNormalization;
let pg, failure;

try {
  pg = await postgresFixture(path.join(root, "postgres"));
  for (const kind of ["node", "rust"]) {
    const result = { kind, responses: [] };
    report.peers.push(result);
    const peer = await accountingProductionPeer(
      kind,
      path.join(root, kind),
      await pg.database(),
      60000,
      result,
    );
    try {
      result.version = await peer.request("/version");
      result.responses = await targetPolicyCases(result.origin);
    } finally {
      await peer.close();
      result.records = await peer.records();
    }
  }
  assert.deepEqual(
    report.peers[1].version,
    report.peers[0].version,
    "Actual production /version on both artifacts",
  );
  Object.assign(report, verifyTargetPolicy(report.peers));
  assert.equal(
    report.wireDifferences.length,
    0,
    "Actual production response differences",
  );
  assert.equal(
    report.loggingDifferences.length,
    0,
    "Actual per-route completion capture differences",
  );
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  await pg?.close();
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    passed: true,
    root,
    requestsPerPeer: report.peers[0].responses.length,
  }),
);
