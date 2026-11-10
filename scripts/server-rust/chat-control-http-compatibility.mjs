// Actual HTTP/SQL/Live and production WorkerConnection. Worker filesystem/native
// responses are controlled; message protection executes production encryption.
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
import { buildRustExample } from "./build.mjs";
import { postgresFixture } from "./postgres-fixture.mjs";
import { hashPassword } from "../../tests/reference-node-server/src/auth/service.ts";
import { password } from "./security-fixtures.mjs";
import { runChatControl } from "./chat-control-http-runner.mjs";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "pglite" },
    profile: { type: "string" },
    runtime: { type: "string" },
    report: { type: "string" },
    boundaries: { type: "boolean", default: false },
  },
});
assert.ok(["pglite", "bundled-postgres", "postgres"].includes(values.database));
assert.ok(!values.runtime || ["node", "rust"].includes(values.runtime));
assert.ok(
  !values.profile || ["none", "password", "accounts"].includes(values.profile),
);
const root = await mkdtemp(path.join(tmpdir(), "cantrip-chat-control-http-"));
console.error(JSON.stringify({ event: "chat-control.created", root }));
const report = {
  suite: "actual-chat-control-http",
  root,
  database: values.database,
  databaseMode: values.database,
  completeReplacement: false,
  profiles: [],
  scope:
    "Chat controls via actual production routers, SQL, App Live and unchanged WorkerConnection; controlled worktree/native responses, actual endpoint message encryption. Full-worker/platform acceptance is separate.",
};
let pg, failure;
try {
  const passwordHash = await hashPassword(password);
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
  if (values.database !== "pglite")
    pg = await postgresFixture(path.join(root, "postgres"));
  for (const profile of values.profile
    ? [values.profile]
    : ["none", "password", "accounts"]) {
    const results = [];
    report.profiles.push({ profile, runtimes: results });
    for (const kind of values.runtime ? [values.runtime] : ["node", "rust"]) {
      const result = {
        kind,
        observations: [],
        snapshotProofs: 0,
        cases: [],
        rawCases: [],
      };
      results.push(result);
      const url =
        pg && (kind === "node" || values.database === "postgres")
          ? await pg.database()
          : undefined;
      await runChatControl({
        kind,
        profile,
        root,
        executable,
        databaseMode: values.database,
        url,
        passwordHash,
        result,
        boundaries: values.boundaries,
        environment: { CANTRIP_FIXTURE_LOGGING: "true" },
        logPath: path.join(root, profile + "-" + kind + ".log"),
      });
      result.rawCaseCommands = structuredClone(
        result.rawCases.flatMap((item) => item.commands),
      );
    }
    if (results.length === 2) {
      assert.deepEqual(
        results[1].cases,
        results[0].cases,
        profile + " complete Chat control responses/commands/state/Live parity",
      );
      assert.deepEqual(
        results[1].controlLogs,
        results[0].controlLogs,
        profile + " operational log parity",
      );
      if (values.boundaries)
        assert.deepEqual(
          results[1].boundaries.map(({ raw, ...c }) => c),
          results[0].boundaries.map(({ raw, ...c }) => c),
          profile + " caller disappearance parity",
        );
    }
  }
  report.passed = true;
} catch (error) {
  failure = error;
  report.failure = { message: error.message, stack: error.stack };
} finally {
  try {
    await pg?.close();
  } catch (error) {
    failure ??= error;
    report.cleanupFailure = error.stack;
  }
  if (values.report)
    await writeFile(values.report, JSON.stringify(report, null, 2) + "\n");
  console.log(
    JSON.stringify({
      root,
      database: values.database,
      cases: report.profiles.map(({ profile, runtimes }) => ({
        profile,
        runtimes: runtimes.map((r) => ({
          kind: r.kind,
          cases: r.cases.length,
          processExit: r.processExit,
        })),
      })),
      passed: !failure,
    }),
  );
}
if (failure) throw failure;
