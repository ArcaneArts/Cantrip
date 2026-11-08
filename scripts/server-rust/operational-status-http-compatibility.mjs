// Actual production routers, SQL, App Live and WorkerConnection. Runtime
// measurements are validated as measurements, not replaced with fixed counters.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtemp,
  mkdir,
  copyFile,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { hashPassword } from "../../cantrip_server/src/auth/service.ts";
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { password } from "./security-fixtures.mjs";
import { runOperationalStatus } from "./operational-status-http-cases.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
const root = await mkdtemp(
  path.join(tmpdir(), "cantrip-operational-status-http-"),
);
console.error(JSON.stringify({ event: "operational-status.created", root }));
const report = {
  root,
  database: values.database,
  completeReplacement: false,
  profiles: [],
  scope:
    "Actual HTTP/worker/Live operational collectors. Platform, packaged and whole-replacement acceptance remain separate.",
};
let pg, failure;
try {
  let executable;
  if (values.runtime !== "node") {
    const built =
      process.env.CANTRIP_RUST_SERVER_BINARY ??
      (await buildRustExample("http-sql-fixture"));
    await mkdir(path.join(root, "bin"));
    executable = path.join(root, "bin", path.basename(built));
    await copyFile(built, executable);
    report.nativeExecutable = {
      path: executable,
      sha256: createHash("sha256")
        .update(await readFile(executable))
        .digest("hex"),
    };
  }
  const passwordHash = await hashPassword(password);
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const peers = [];
    report.profiles.push({ profile, runtimes: peers });
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        cases: [],
        healthBodies: [],
        metricsDocuments: [],
        exits: [],
      };
      peers.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      await runOperationalStatus({
        kind,
        profile,
        root,
        executable,
        databaseMode: values.database,
        url,
        passwordHash,
        result,
      });
    }
    if (peers.length === 2)
      assert.deepEqual(
        peers[1].cases,
        peers[0].cases,
        profile + " operational HTTP/collector behavioral parity",
      );
  }
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.teardownFailure = { message: error.message };
  }
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
}
if (failure) throw failure;
console.log(
  JSON.stringify({
    root,
    database: values.database,
    profiles: report.profiles.map((p) => ({
      profile: p.profile,
      peers: p.runtimes.map((r) => ({
        kind: r.kind,
        cases: r.cases.length,
        exits: r.exits,
      })),
    })),
  }),
);
